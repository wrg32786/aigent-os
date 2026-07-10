#!/usr/bin/env python3
"""Compute aigent-OS runtime state from the operational vault.

The public repository historically used ``AIGENT_VAULT`` for both the project
root and the actual ``vault/`` directory. ``resolve_vault_path`` accepts both
layouts and deliberately prefers the directory containing operational memory
files such as BODY_STATE.json and SESSION_LOG.md.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable


def _native_path(value: str) -> Path:
    """Translate Git-Bash drive paths when native Windows Python is in use."""
    value = os.path.expanduser(value)
    if os.name == "nt" and re.match(r"^/[A-Za-z]/", value):
        value = f"{value[1].upper()}:{value[2:]}"
    return Path(value).resolve()


def _unique_paths(paths: Iterable[Path]) -> list[Path]:
    seen: set[str] = set()
    result: list[Path] = []
    for path in paths:
        marker = os.path.normcase(str(path))
        if marker not in seen:
            seen.add(marker)
            result.append(path)
    return result


def _vault_score(path: Path) -> int:
    """Score how strongly a path resembles the operational Obsidian vault."""
    score = 0
    memory = path / "memory"
    if path.is_dir():
        score += 1
    if memory.is_dir():
        score += 2
    markers = {
        "BODY_STATE.json": 8,
        "SESSION_LOG.md": 6,
        "ACTIVE_PRIORITIES.md": 6,
        "DELEGATION_TRACKER.md": 3,
        "DECISION_LOG.md": 3,
    }
    for name, weight in markers.items():
        if (memory / name).exists():
            score += weight
    if (path / "daily").is_dir():
        score += 2
    if (path / "concepts").is_dir():
        score += 1
    return score


def resolve_vault_path() -> Path:
    """Return the operational vault for old and new environment layouts."""
    explicit_raw = os.environ.get("AIGENT_VAULT")
    root_raw = os.environ.get("AIGENT_ROOT")

    explicit = _native_path(explicit_raw) if explicit_raw else None
    root = _native_path(root_raw) if root_raw else None
    home = _native_path("~/.aigent")

    candidates: list[Path] = []
    if explicit is not None:
        candidates.extend([explicit / "vault", explicit])
    if root is not None:
        candidates.extend([root / "vault", root])
    candidates.extend([home / "vault", home])
    candidates = _unique_paths(candidates)

    scored = [(path, _vault_score(path)) for path in candidates]
    best_path, best_score = max(scored, key=lambda item: item[1])
    if best_score > 0:
        return best_path

    if explicit is not None:
        return explicit if explicit.name.lower() == "vault" else explicit / "vault"
    if root is not None:
        return root / "vault"
    return home / "vault"


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError, TypeError):
        return None


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temp_path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp_path, path)


def get_open_skill_gaps(path: Path) -> list[dict[str, str]]:
    gaps: list[dict[str, str]] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            lowered = line.lower()
            if "| open |" not in lowered and "| open|" not in lowered:
                continue
            parts = [part.strip() for part in line.split("|") if part.strip()]
            if len(parts) >= 3:
                gaps.append({"date": parts[0], "description": parts[2]})
    except OSError:
        pass
    return gaps


def get_blocked_items(path: Path) -> list[str]:
    items: list[str] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            lowered = stripped.lower()
            if not (stripped.startswith("- ") or stripped.startswith("|")):
                continue
            if "blocked" in lowered or "stale" in lowered:
                items.append(stripped[:100])
    except OSError:
        pass
    return items[:10]


def get_pending_decisions(vault: Path, today: date) -> list[dict[str, Any]]:
    decisions: list[dict[str, Any]] = []
    log_path = vault / "memory" / "DECISION_LOG.md"
    outcomes_path = vault / "memory" / "DECISION_OUTCOMES.md"
    try:
        log_content = log_path.read_text(encoding="utf-8") if log_path.exists() else ""
        outcomes_content = outcomes_path.read_text(encoding="utf-8") if outcomes_path.exists() else ""
    except OSError:
        return decisions

    date_pattern = re.compile(r"(\d{4}-\d{2}-\d{2})")
    for line in log_content.splitlines():
        match = date_pattern.search(line)
        if not match or "|" not in line:
            continue
        try:
            decision_date = datetime.strptime(match.group(1), "%Y-%m-%d").date()
        except ValueError:
            continue
        age = (today - decision_date).days
        if not any(abs(age - threshold) <= 3 for threshold in (30, 60, 90)):
            continue
        if match.group(1) in outcomes_content:
            continue
        parts = [part.strip() for part in line.split("|") if part.strip()]
        summary = parts[1] if len(parts) > 1 else line[:80]
        decisions.append({"date": match.group(1), "age_days": age, "summary": summary})
    return decisions[:3]


def get_open_threads(vault: Path) -> list[str]:
    path = vault / "memory" / "SESSION_LOG.md"
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return []

    index = max(content.rfind("Open thread"), content.rfind("open thread"))
    if index < 0:
        return []
    threads: list[str] = []
    for line in content[index : index + 500].splitlines()[1:]:
        stripped = line.strip()
        if stripped.startswith("- "):
            threads.append(stripped[2:][:100])
        elif stripped.startswith("#") or stripped.startswith("---"):
            break
    return threads[:8]


def get_next_action(vault: Path) -> str | None:
    path = vault / "memory" / "SESSION_LOG.md"
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return None

    index = max(content.rfind("Next action"), content.rfind("next action"))
    if index < 0:
        return None
    for line in content[index : index + 300].splitlines()[1:]:
        stripped = line.strip()
        if stripped.startswith("- "):
            return stripped[2:][:150]
        if stripped and not stripped.startswith("#"):
            return stripped[:150]
    return None


def count_memory_candidates(vault: Path) -> int:
    path = vault / "memory" / "MEMORY_CANDIDATES.md"
    try:
        content = path.read_text(encoding="utf-8").lower()
    except OSError:
        return 0
    return content.count("status:staged") + content.count("status: staged")


def _older_than(value: str, today: date, days: int) -> bool:
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d").date()
        return (today - parsed).days > days
    except (TypeError, ValueError):
        return True


def compute_state(vault: Path, now: datetime | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    now = now or datetime.now(timezone.utc)
    today = now.date()
    runtime_dir = vault / "memory" / "runtime"
    state_path = runtime_dir / "ACTIVE_STATE.json"
    previous = read_json(state_path)
    previous_mode = previous.get("mode", "idle") if previous else "idle"

    body_state = read_json(vault / "memory" / "BODY_STATE.json") or {}
    body = body_state.get("state", {}) if isinstance(body_state.get("state", {}), dict) else {}
    backlog = int(body.get("memory_candidate_backlog", 0) or 0)
    pressure = {
        "context": body.get("context_pressure", "low"),
        "memory": "high" if backlog > 30 else "medium" if backlog > 15 else "low",
        "decision": "medium" if int(body.get("decision_reviews_due", 0) or 0) > 0 else "low",
        "token": body.get("token_pressure", "low"),
        "attention": "medium" if body.get("attention_drift_active", False) else "low",
    }

    capsule = body.get("last_capsule") if isinstance(body.get("last_capsule"), dict) else None
    active_capsule = None
    if capsule and capsule.get("status") in {"active", "paused"}:
        active_capsule = {
            "id": capsule.get("id"),
            "objective": capsule.get("objective"),
            "status": capsule.get("status"),
            "path": capsule.get("path"),
        }

    open_threads = get_open_threads(vault)
    next_action = get_next_action(vault)
    last_verified = None
    if active_capsule and capsule and capsule.get("path"):
        capsule_path = vault / str(capsule["path"])
        try:
            content = capsule_path.read_text(encoding="utf-8")
            next_match = re.search(r'next_valid_action:\s*["\']?(.+?)["\']?\s*$', content, re.MULTILINE)
            verified_match = re.search(r'last_verified_state:\s*["\']?(.+?)["\']?\s*$', content, re.MULTILINE)
            if next_match:
                next_action = next_match.group(1).strip('"\'')
            if verified_match:
                last_verified = verified_match.group(1).strip('"\'')
        except OSError:
            pass

    pending_decisions = get_pending_decisions(vault, today)
    skill_gaps = get_open_skill_gaps(vault / "memory" / "SKILL_GAPS.md")
    blocked_items = get_blocked_items(vault / "memory" / "DELEGATION_TRACKER.md")
    memory_candidates = count_memory_candidates(vault)

    if active_capsule and active_capsule["status"] == "paused":
        mode = "paused"
    elif blocked_items:
        mode = "blocked"
    elif active_capsule or next_action:
        mode = "active"
    else:
        mode = "idle"

    objective = active_capsule.get("objective") if active_capsule else None
    objective = objective or next_action

    old_gaps = [gap for gap in skill_gaps if _older_than(gap.get("date", ""), today, 7)]
    old_blocked: list[str] = []
    for item in blocked_items:
        match = re.search(r"(\d{4}-\d{2}-\d{2})", item)
        if match is None or _older_than(match.group(1), today, 3):
            old_blocked.append(item)

    reflexes = {
        "should_capsule": pressure["context"] in {"high", "critical"},
        "should_digest": memory_candidates > 30,
        "should_skill_hunt": bool(old_gaps),
        "should_close": int(body.get("session_age_minutes", 0) or 0) > 120,
        "should_escalate": bool(old_blocked),
    }

    state = {
        "version": "0.2",
        "updated_at": now.isoformat(),
        "vault_path": str(vault),
        "mode": mode,
        "current_objective": objective,
        "active_capsule": active_capsule,
        "active_loop": None,
        "pressure": pressure,
        "open_threads": open_threads,
        "pending_decisions": [item["summary"] for item in pending_decisions],
        "skill_gaps": [item["description"] for item in skill_gaps],
        "blocked_items": blocked_items,
        "last_verified_state": last_verified,
        "next_valid_action": next_action,
        "reflexes": reflexes,
    }

    events: list[dict[str, Any]] = []
    if previous_mode != mode:
        events.append({"time": now.isoformat(), "event": "mode_change", "from": previous_mode, "to": mode})
    if previous and previous.get("current_objective") != objective and objective:
        events.append({"time": now.isoformat(), "event": "objective_set", "value": objective})
    if not previous:
        events.append({"time": now.isoformat(), "event": "state_initialized"})
    return state, events


def main() -> int:
    vault = resolve_vault_path()
    if "--print-vault" in sys.argv:
        print(vault)
        return 0

    runtime_dir = vault / "memory" / "runtime"
    state_path = runtime_dir / "ACTIVE_STATE.json"
    events_path = runtime_dir / "STATE_EVENTS.jsonl"
    state, events = compute_state(vault)
    atomic_write_json(state_path, state)

    if events:
        runtime_dir.mkdir(parents=True, exist_ok=True)
        with events_path.open("a", encoding="utf-8") as handle:
            for event in events:
                handle.write(json.dumps(event, ensure_ascii=False) + "\n")

    active_reflexes = [name.removeprefix("should_") for name, enabled in state["reflexes"].items() if enabled]
    print(
        f"[runtime] vault={vault} mode={state['mode']} "
        f"objective={state['current_objective'] or 'none'} "
        f"reflexes={','.join(active_reflexes) or 'none'}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
