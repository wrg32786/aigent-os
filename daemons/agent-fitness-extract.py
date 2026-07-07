#!/usr/bin/env python3
"""agent-fitness-extract.py — Somatic v0.5.0 sub-agent dispatch tracker.

Scans the latest Claude Code JSONL transcript for `Agent` tool_use + tool_result pairs,
classifies outcome, appends rows to memory/AGENT_FITNESS.md.

Usage:
    python3 daemons/agent-fitness-extract.py [--session <id>] [--vault <path>] [--jsonl <path>]

Exits:
    0 always (best-effort post-processing)
"""

import sys, os, json, re, argparse, glob
from pathlib import Path
from datetime import datetime, timezone


def find_latest_jsonl(project_dir):
    files = glob.glob(os.path.join(project_dir, "*.jsonl"))
    if not files:
        return None
    return max(files, key=os.path.getmtime)


def classify_outcome(result_content_str, is_error):
    """Apply heuristic classification to tool_result content."""
    s = result_content_str.lower()
    if is_error or "inputvalidationerror" in s or '"error":' in s or "tool_use_error" in s:
        return "errored", "is_error or error keyword in result"
    # blocked: hard stops where the agent could not do the work
    blocked_keywords = [
        "being denied", "permission denied", "blocked on", "sandbox",
        "cannot edit", "cannot write", "are denied", "denied on",
        "blocked:", "**blocked", "status: blocked", "blocker-found",
        "cannot proceed", "will not proceed",
    ]
    if any(p in s for p in blocked_keywords):
        return "blocked", "blocked/denied keyword"
    # partial: agent did some work but couldn't complete
    partial_keywords = [
        "stopped short", "incomplete", "unable to verify", "blocked —",
        "cannot verify", "could not verify", "partial honesty ledger",
        "partial — build not complete", "stopped short of",
    ]
    if any(p in s for p in partial_keywords):
        return "partial", "partial completion keyword"
    return "clean", "no failure markers detected"


def extract_dispatches(jsonl_path, session_id):
    """Walk JSONL, return list of dispatch records."""
    dispatches = {}  # tool_use_id → record
    if not os.path.exists(jsonl_path):
        return []
    with open(jsonl_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                j = json.loads(line)
            except Exception:
                continue
            ts = j.get("timestamp") or (j.get("message", {}) or {}).get("timestamp", "")
            t = j.get("type")

            # Look for assistant tool_use Agent calls
            if t == "assistant":
                msg = j.get("message", {}) or {}
                content = msg.get("content", []) or []
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "Agent":
                        tu_id = c.get("id", "")
                        if not tu_id:
                            continue
                        inp = c.get("input", {}) or {}
                        dispatches[tu_id] = {
                            "tool_use_id": tu_id,
                            "agent_name": inp.get("subagent_type", "general-purpose"),
                            "model": inp.get("model", "default"),
                            "task": (inp.get("description", "") or inp.get("prompt", "")[:80]).replace("|", "&#124;")[:80],
                            "dispatch_ts": ts,
                            "result_ts": None,
                            "tool_uses": None,
                            "is_error": False,
                            "result_text": "",
                        }

            # Look for user tool_result (matching tool_use_id)
            if t == "user":
                msg = j.get("message", {}) or {}
                content = msg.get("content", []) or []
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "tool_result":
                        tu_id = c.get("tool_use_id", "")
                        if tu_id in dispatches:
                            d = dispatches[tu_id]
                            d["result_ts"] = ts
                            d["is_error"] = bool(c.get("is_error"))
                            # content can be list or string
                            rc = c.get("content", "")
                            if isinstance(rc, list):
                                rc = " ".join(
                                    (x.get("text", "") if isinstance(x, dict) else str(x))
                                    for x in rc
                                )
                            d["result_text"] = str(rc)[:2000]
                            # Try to extract tool_uses count from "tool_uses: N" pattern in summary
                            m = re.search(r"tool_uses:\s*(\d+)", d["result_text"])
                            if m:
                                d["tool_uses"] = int(m.group(1))

    # Filter to only those with results
    return [d for d in dispatches.values() if d["result_ts"]]


def parse_iso(ts):
    if not ts: return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def existing_dedup_keys(ledger_path):
    """Return set of (session_id, tool_use_id) tuples already in ledger."""
    keys = set()
    if not ledger_path.exists():
        return keys
    text = ledger_path.read_text(encoding="utf-8")
    # Row format: | date | session | tool_use_id | agent | ... |
    for m in re.finditer(r"^\|\s*\d{4}-\d{2}-\d{2}\s*\|\s*(\S+?)\s*\|\s*(\S+?)\s*\|", text, re.M):
        keys.add((m.group(1), m.group(2)))
    return keys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", default=os.environ.get("AIGENT_VAULT", os.path.expanduser("~/.aigent")))
    parser.add_argument("--session", default=None, help="JSONL session id (basename)")
    parser.add_argument("--jsonl", default=None, help="explicit JSONL path (overrides session)")
    parser.add_argument("--project-dir", default=os.environ.get("AIGENT_PROJECT_DIR", os.path.expanduser("~/.claude/projects")))
    args = parser.parse_args()

    if args.jsonl:
        jsonl_path = args.jsonl
        session_id = os.path.splitext(os.path.basename(jsonl_path))[0]
    elif args.session:
        jsonl_path = os.path.join(args.project_dir, f"{args.session}.jsonl")
        session_id = args.session
    else:
        jsonl_path = find_latest_jsonl(args.project_dir)
        if not jsonl_path:
            print("No JSONL found in project dir; nothing to extract.")
            sys.exit(0)
        session_id = os.path.splitext(os.path.basename(jsonl_path))[0]

    ledger = Path(args.vault) / "memory" / "AGENT_FITNESS.md"
    err_log = Path(args.vault) / "memory" / ".daemon-errors.log"

    if not ledger.exists():
        print(f"WARN: ledger missing at {ledger}; not creating", file=sys.stderr)
        sys.exit(0)

    existing = existing_dedup_keys(ledger)
    dispatches = extract_dispatches(jsonl_path, session_id)

    rows_to_append = []
    for d in dispatches:
        key = (session_id, d["tool_use_id"])
        if key in existing:
            continue
        outcome, note = classify_outcome(d["result_text"], d["is_error"])
        d_ts = parse_iso(d["dispatch_ts"])
        r_ts = parse_iso(d["result_ts"])
        duration_ms = ""
        if d_ts and r_ts:
            duration_ms = str(int((r_ts - d_ts).total_seconds() * 1000))
        date = (r_ts or datetime.now(timezone.utc)).strftime("%Y-%m-%d")
        # Store FULL session_id + tool_use_id so dedup works across runs.
        # Truncation in display is the consumer's job (/agent-fitness skill).
        tools = str(d.get("tool_uses") or "?")
        task_clean = d["task"].replace("\n", " ").replace("|", "&#124;")
        row = f"| {date} | {session_id} | {d['tool_use_id']} | {d['agent_name']} | {d['model']} | {task_clean} | {tools} | {duration_ms} | {outcome} | {note} |"
        rows_to_append.append(row)

    if not rows_to_append:
        print(f"No new dispatches to append (existing={len(existing)}, scanned={len(dispatches)}).")
        sys.exit(0)

    with ledger.open("a", encoding="utf-8") as f:
        f.write("\n".join(rows_to_append) + "\n")

    print(f"Appended {len(rows_to_append)} new dispatch row(s) to AGENT_FITNESS.md")
    print(f"  session: {session_id}, total existing: {len(existing)}, total now: {len(existing) + len(rows_to_append)}")
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        # argparse + main() use SystemExit for normal flow control. Don't override.
        raise
    except Exception as e:
        # Best-effort: never block parent caller. Log and exit clean (0).
        # This is the catch-all for unhandled exceptions, NOT for normal exits.
        try:
            err_log = Path(os.environ.get("AIGENT_VAULT", os.path.expanduser("~/.aigent"))) / "memory" / ".daemon-errors.log"
            err_log.parent.mkdir(parents=True, exist_ok=True)
            with err_log.open("a", encoding="utf-8") as f:
                f.write(f"{datetime.now(timezone.utc).isoformat()} [agent-fitness-extract] {type(e).__name__}: {e}\n")
        except Exception:
            pass
        print(f"[agent-fitness-extract] error: {e}", file=sys.stderr)
        sys.exit(0)
