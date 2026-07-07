#!/usr/bin/env python3
"""capsule-compact.py — Somatic v0.4.5 chain compaction.

Walks parent_capsule_id chain backward from a head capsule.
If chain length >= 5, summarizes oldest 3 into a chain-summary capsule.

Usage:
    python3 daemons/capsule-compact.py <head_capsule_id> [--vault <path>] [--threshold N] [--summarize-count N]

Exits:
    0 if compaction occurred or no-op (short chain)
    1 if head capsule not found or any error
"""

import sys, os, re, argparse
from pathlib import Path
from datetime import datetime, timezone


def parse_frontmatter(text):
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.DOTALL)
    if not m:
        return None, text
    fm = {}
    for line in m.group(1).splitlines():
        if ":" in line and not line.startswith(" "):
            k, _, v = line.partition(":")
            fm[k.strip()] = v.strip()
    return fm, m.group(2)


def write_frontmatter(path, fm, body):
    keys_order = [
        "capsule_id", "objective", "status", "created_at", "resolved_at",
        "parent_capsule_id", "trigger", "compacted_summary", "compacted_count",
        "compacted_ids", "compacted_into", "demoted_at", "demoted_reason",
    ]
    seen = set()
    lines = []
    for k in keys_order:
        if k in fm:
            lines.append(f"{k}: {fm[k]}")
            seen.add(k)
    for k, v in fm.items():
        if k not in seen:
            lines.append(f"{k}: {v}")
    path.write_text("---\n" + "\n".join(lines) + "\n---\n" + body)


def walk_chain(capsules_dir, head_id):
    """Walk parent_capsule_id chain backward. Returns list of (capsule_id, fm, body, path)."""
    chain = []
    seen = set()
    cur = head_id
    while cur and cur not in seen and cur != "null":
        seen.add(cur)
        path = capsules_dir / f"{cur}.md"
        if not path.exists():
            chain.append((cur, None, None, None))
            break
        fm, body = parse_frontmatter(path.read_text())
        chain.append((cur, fm, body, path))
        cur = fm.get("parent_capsule_id", "null").strip() if fm else "null"
    return chain


def summarize_capsules(to_summarize):
    """Concatenate objectives + open_threads + held decisions."""
    objectives = []
    open_threads = []
    held_decisions = []
    for cid, fm, body, _ in to_summarize:
        objectives.append(f"- **{cid}** ({fm.get('created_at', 'unknown')}): {fm.get('objective', '<no objective>')}")
        # Extract open_threads section
        ot = re.search(r"## open_threads\n(.*?)(?=\n##|\Z)", body or "", re.DOTALL)
        if ot:
            for line in ot.group(1).strip().splitlines():
                if line.strip().startswith("-") and "(next move:" in line:
                    open_threads.append(f"  - [{cid}] {line.strip().lstrip('- ').strip()}")
        # Extract held decisions
        dm = re.search(r"## decisions_made_this_session\n(.*?)(?=\n##|\Z)", body or "", re.DOTALL)
        if dm:
            for line in dm.group(1).strip().splitlines():
                if "(held)" in line or "status: held" in line:
                    held_decisions.append(f"  - [{cid}] {line.strip().lstrip('- ').strip()}")
    body = "## Compacted from chain\n\n"
    body += "Original capsules summarized into this one (oldest first):\n\n"
    body += "\n".join(objectives) + "\n\n"
    body += "## Open threads still live across the compacted set\n\n"
    body += ("\n".join(open_threads) if open_threads else "- (none recorded as open in compacted capsules)") + "\n\n"
    body += "## Decisions held across the compacted set\n\n"
    body += ("\n".join(held_decisions) if held_decisions else "- (none recorded as held in compacted capsules)") + "\n\n"
    body += "## Note\n\nFull capsule files for the compacted entries remain on disk under `memory/capsules/`. Each carries `compacted_into: <this id>` in their frontmatter for traversal.\n"
    return body


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("head_id", help="capsule_id at the head of the chain (newest)")
    parser.add_argument("--vault", default=os.environ.get("AIGENT_VAULT", os.path.expanduser("~/.aigent")))
    parser.add_argument("--threshold", type=int, default=5,
                        help="minimum chain length before compaction triggers")
    parser.add_argument("--summarize-count", type=int, default=3,
                        help="number of oldest capsules to summarize")
    args = parser.parse_args()

    capsules_dir = Path(args.vault) / "memory" / "capsules"
    if not capsules_dir.exists():
        print(f"ERROR: capsules dir not found: {capsules_dir}", file=sys.stderr)
        sys.exit(1)

    chain = walk_chain(capsules_dir, args.head_id)
    if not chain or chain[0][1] is None:
        print(f"ERROR: head capsule {args.head_id} not found", file=sys.stderr)
        sys.exit(1)

    # Check for missing capsules in chain (broken)
    for cid, fm, _, path in chain:
        if fm is None:
            print(f"WARNING: chain link {cid} not found on disk; stopping walk", file=sys.stderr)
            break

    if len(chain) < args.threshold:
        print(f"chain_length={len(chain)} threshold={args.threshold} — no-op")
        sys.exit(0)

    # Take the oldest summarize-count
    to_summarize = chain[-args.summarize_count:]
    keep_in_chain = chain[:-args.summarize_count]
    new_parent_for_summary = to_summarize[-1][1].get("parent_capsule_id", "null").strip() if to_summarize[-1][1] else "null"

    # Build summary capsule
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    summary_id = f"chain-summary-{args.head_id}-{now[:10].replace('-','')}"
    summary_path = capsules_dir / f"{summary_id}.md"
    summary_fm = {
        "capsule_id": summary_id,
        "objective": f"Compacted summary of {args.summarize_count} older capsules in chain ending at {args.head_id}",
        "status": "resolved",
        "created_at": now,
        "resolved_at": now,
        "parent_capsule_id": new_parent_for_summary,
        "trigger": "compaction",
        "compacted_summary": "true",
        "compacted_count": str(args.summarize_count),
        "compacted_ids": "[" + ", ".join(c[0] for c in to_summarize) + "]",
    }
    summary_body = summarize_capsules(to_summarize)
    write_frontmatter(summary_path, summary_fm, summary_body)

    # Update the boundary capsule (kept-in-chain, oldest of the keepers) to point at summary
    if keep_in_chain:
        boundary = keep_in_chain[-1]
        bid, bfm, bbody, bpath = boundary
        bfm["parent_capsule_id"] = summary_id
        write_frontmatter(bpath, bfm, bbody)

    # Mark each compacted capsule with compacted_into
    for cid, fm, body, path in to_summarize:
        fm["compacted_into"] = summary_id
        write_frontmatter(path, fm, body)

    new_chain = walk_chain(capsules_dir, args.head_id)
    print(f"compacted: {len(chain)} → {len(new_chain)} chain length")
    print(f"summary_capsule: {summary_id}")
    print(f"compacted_ids: {[c[0] for c in to_summarize]}")
    sys.exit(0)


if __name__ == "__main__":
    main()
