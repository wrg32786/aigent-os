#!/usr/bin/env python3
"""
update-active-state.py — aigent-OS runtime state computer.
Reads vault state files, computes ACTIVE_STATE.json, appends to STATE_EVENTS.jsonl.
Run on every /open and /close. Never hand-edit ACTIVE_STATE.json.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path


def env_vault():
    return os.environ.get("AIGENT_VAULT", os.path.expanduser("~/.aigent"))


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def count_md_table_rows(path):
    """Count non-header data rows in a markdown table file."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        count = 0
        for line in lines:
            line = line.strip()
            if line.startswith("|") and not line.startswith("| Date") and not line.startswith("|---") and not line.startswith("| ---"):
                parts = [p.strip() for p in line.split("|") if p.strip()]
                if len(parts) >= 2:
                    count += 1
        return count
    except Exception:
        return 0


def get_open_skill_gaps(path):
    """Get skill gaps with status=open."""
    gaps = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                if "| open |" in line.lower() or "| open|" in line.lower():
                    parts = [p.strip() for p in line.split("|") if p.strip()]
                    if len(parts) >= 3:
                        gaps.append({"date": parts[0], "description": parts[2]})
    except Exception:
        pass
    return gaps


def get_blocked_items(path):
    """Get delegation tracker items with blocked status."""
    items = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        # Look for items with status: blocked or stale
        for line in content.split("\n"):
            lower = line.lower()
            if "blocked" in lower or "stale" in lower:
                if line.startswith("- ") or line.startswith("| "):
                    items.append(line.strip()[:100])
    except Exception:
        pass
    return items[:10]  # cap at 10


def get_pending_decisions(vault, today):
    """Find decisions without outcome entries at 30/60/90d marks."""
    decisions = []
    log_path = vault / "memory" / "DECISION_LOG.md"
    outcomes_path = vault / "memory" / "DECISION_OUTCOMES.md"
    try:
        log_content = log_path.read_text(encoding="utf-8") if log_path.exists() else ""
        outcomes_content = outcomes_path.read_text(encoding="utf-8") if outcomes_path.exists() else ""

        date_re = re.compile(r"(\d{4}-\d{2}-\d{2})")
        for line in log_content.split("\n"):
            m = date_re.search(line)
            if m and "|" in line:
                try:
                    d = datetime.strptime(m.group(1), "%Y-%m-%d").date()
                    age = (today - d).days
                    if any(abs(age - t) <= 3 for t in [30, 60, 90]):
                        # Check if outcome exists
                        if m.group(1) not in outcomes_content:
                            parts = [p.strip() for p in line.split("|") if p.strip()]
                            summary = parts[1] if len(parts) > 1 else line[:80]
                            decisions.append({"date": m.group(1), "age_days": age, "summary": summary})
                except Exception:
                    pass
    except Exception:
        pass
    return decisions[:3]


def get_open_threads(vault):
    """Get open threads from latest SESSION_LOG entry."""
    threads = []
    path = vault / "memory" / "SESSION_LOG.md"
    try:
        content = path.read_text(encoding="utf-8")
        # Find last "Open thread" section
        idx = content.rfind("Open thread")
        if idx == -1:
            idx = content.rfind("open thread")
        if idx >= 0:
            block = content[idx:idx+500]
            for line in block.split("\n")[1:]:
                line = line.strip()
                if line.startswith("- "):
                    threads.append(line[2:].strip()[:100])
                elif line.startswith("#") or line.startswith("---"):
                    break
    except Exception:
        pass
    return threads[:8]


def get_next_action(vault):
    """Get next action from latest SESSION_LOG entry."""
    path = vault / "memory" / "SESSION_LOG.md"
    try:
        content = path.read_text(encoding="utf-8")
        idx = content.rfind("Next action")
        if idx == -1:
            idx = content.rfind("next action")
        if idx >= 0:
            block = content[idx:idx+300]
            lines = block.split("\n")
            for line in lines[1:]:
                line = line.strip()
                if line.startswith("- "):
                    return line[2:].strip()[:150]
                elif line and not line.startswith("#"):
                    return line[:150]
    except Exception:
        pass
    return None


def count_memory_candidates(vault):
    """Count staged candidates in MEMORY_CANDIDATES.md."""
    path = vault / "memory" / "MEMORY_CANDIDATES.md"
    try:
        content = path.read_text(encoding="utf-8")
        return content.lower().count("status:staged") + content.lower().count("status: staged")
    except Exception:
        return 0


def main():
    vault = Path(env_vault())
    runtime_dir = vault / "memory" / "runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)

    state_path = runtime_dir / "ACTIVE_STATE.json"
    events_path = runtime_dir / "STATE_EVENTS.jsonl"
    now = datetime.now(timezone.utc)
    today = now.date()

    # Read previous state for diff
    prev_state = read_json(state_path)
    prev_mode = prev_state.get("mode", "idle") if prev_state else "idle"

    # ── Read sources ──
    body_state = read_json(vault / "memory" / "BODY_STATE.json") or {}
    body = body_state.get("state", {})

    # Pressures from BODY_STATE
    pressure = {
        "context": body.get("context_pressure", "low"),
        "memory": "high" if body.get("memory_candidate_backlog", 0) > 30 else
                  "medium" if body.get("memory_candidate_backlog", 0) > 15 else "low",
        "decision": "medium" if body.get("decision_reviews_due", 0) > 0 else "low",
        "token": body.get("token_pressure", "low"),
        "attention": "medium" if body.get("attention_drift_active", False) else "low"
    }

    # Capsule
    capsule = body.get("last_capsule")
    active_capsule = None
    if capsule and capsule.get("status") in ("active", "paused"):
        active_capsule = {
            "id": capsule.get("id"),
            "objective": capsule.get("objective"),
            "status": capsule.get("status"),
            "path": capsule.get("path")
        }

    # Open threads + next action
    open_threads = get_open_threads(vault)
    next_action = get_next_action(vault)

    # If capsule has next_valid_action, prefer that
    if active_capsule and capsule.get("path"):
        capsule_path = vault / capsule["path"]
        if capsule_path.exists():
            try:
                content = capsule_path.read_text(encoding="utf-8")
                nva_match = re.search(r"next_valid_action:\s*\"(.+?)\"", content)
                if nva_match:
                    next_action = nva_match.group(1)
                lvs_match = re.search(r"last_verified_state:\s*\"(.+?)\"", content)
                last_verified = lvs_match.group(1) if lvs_match else None
            except Exception:
                last_verified = None
        else:
            last_verified = None
    else:
        last_verified = None

    # Pending decisions
    pending_decisions = get_pending_decisions(vault, today)

    # Skill gaps
    skill_gaps = get_open_skill_gaps(vault / "memory" / "SKILL_GAPS.md")

    # Blocked items
    blocked_items = get_blocked_items(vault / "memory" / "DELEGATION_TRACKER.md")

    # Memory candidate count
    mem_candidates = count_memory_candidates(vault)

    # ── Compute mode ──
    if active_capsule and active_capsule["status"] == "paused":
        mode = "paused"
    elif blocked_items:
        mode = "blocked"
    elif active_capsule or next_action:
        mode = "active"
    else:
        mode = "idle"

    # ── Compute objective ──
    objective = None
    if active_capsule:
        objective = active_capsule.get("objective")
    if not objective and next_action:
        objective = next_action

    # ── Compute reflexes ──
    # Skill gaps older than 7 days
    old_gaps = []
    for g in skill_gaps:
        try:
            from datetime import datetime as _dt
            gap_date = _dt.strptime(g.get("date", ""), "%Y-%m-%d").date()
            if (today - gap_date).days > 7:
                old_gaps.append(g)
        except Exception:
            old_gaps.append(g)  # if undated, assume old

    # Blocked items older than 3 days (check for date-like prefix)
    old_blocked = []
    for b in blocked_items:
        try:
            date_match = re.search(r"(\d{4}-\d{2}-\d{2})", b)
            if date_match:
                b_date = datetime.strptime(date_match.group(1), "%Y-%m-%d").date()
                if (today - b_date).days > 3:
                    old_blocked.append(b)
            else:
                old_blocked.append(b)  # if undated, assume old
        except Exception:
            old_blocked.append(b)

    reflexes = {
        "should_capsule": pressure["context"] in ("high", "critical"),
        "should_digest": mem_candidates > 30,
        "should_skill_hunt": len(old_gaps) > 0,  # gaps older than 7 days
        "should_close": body.get("session_age_minutes", 0) > 120,
        "should_escalate": len(old_blocked) > 0  # blocked items older than 3 days
    }

    # ── Build state ──
    state = {
        "version": "0.1",
        "updated_at": now.isoformat(),
        "mode": mode,
        "current_objective": objective,
        "active_capsule": active_capsule,
        "active_loop": None,
        "pressure": pressure,
        "open_threads": open_threads,
        "pending_decisions": [d["summary"] for d in pending_decisions],
        "skill_gaps": [g["description"] for g in skill_gaps],
        "blocked_items": blocked_items,
        "last_verified_state": last_verified,
        "next_valid_action": next_action,
        "reflexes": reflexes
    }

    # ── Write state ──
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)

    # ── Append events for state changes ──
    events = []
    if prev_mode != mode:
        events.append({"time": now.isoformat(), "event": "mode_change", "from": prev_mode, "to": mode})
    if prev_state and prev_state.get("current_objective") != objective and objective:
        events.append({"time": now.isoformat(), "event": "objective_set", "value": objective})
    if not prev_state:
        events.append({"time": now.isoformat(), "event": "state_initialized"})

    if events:
        with open(events_path, "a", encoding="utf-8") as f:
            for ev in events:
                f.write(json.dumps(ev, ensure_ascii=False) + "\n")

    # ── Summary to stdout ──
    active_reflexes = [k.replace("should_", "") for k, v in reflexes.items() if v]
    print(f"[runtime] mode={mode} objective={objective or 'none'} reflexes={','.join(active_reflexes) or 'none'}")


if __name__ == "__main__":
    main()
