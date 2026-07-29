#!/usr/bin/env python3
"""agent-fitness-report.py — Somatic v0.5.1 calibration reporter.

Reads memory/AGENT_FITNESS.md, computes per-agent calibration ratios + trends,
surfaces failing patterns. Companion to agent-fitness-extract.py.

Usage:
    python3 daemons/agent-fitness-report.py [--vault <path>] [--days N]

Output: stdout report. No mutations.
"""

import sys, os, re, argparse, json
from pathlib import Path
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta

from render_boundary import inert


def decoded_cell(cell):
    try:
        value = json.loads(cell)
        return value if isinstance(value, str) else cell
    except (json.JSONDecodeError, TypeError):
        return cell


def parse_ledger(path):
    """Returns list of dicts per row."""
    rows = []
    if not path.exists():
        return rows
    text = path.read_text(encoding="utf-8")
    for line in text.splitlines():
        if not line.startswith("| 2026-") and not line.startswith("| 2027-"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 10:
            continue
        rows.append({
            "date": cells[0],
            "session": decoded_cell(cells[1]),
            "tool_id": decoded_cell(cells[2]),
            "agent": decoded_cell(cells[3]),
            "model": decoded_cell(cells[4]),
            "task": decoded_cell(cells[5]),
            "tools": decoded_cell(cells[6]),
            "duration_ms": decoded_cell(cells[7]),
            "outcome": decoded_cell(cells[8]),
            "notes": decoded_cell(cells[9]),
        })
    return rows


def filter_window(rows, days):
    if not days:
        return rows
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    out = []
    for r in rows:
        try:
            d = datetime.strptime(r["date"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
            if d >= cutoff:
                out.append(r)
        except Exception:
            pass
    return out


def calibration(rows, agent):
    sub = [r for r in rows if r["agent"] == agent]
    by_outcome = Counter(r["outcome"] for r in sub)
    total = len(sub)
    errored = by_outcome.get("errored", 0)
    clean = by_outcome.get("clean", 0)
    nonerr = total - errored
    ratio = (clean / nonerr) if nonerr else None
    return {
        "total": total,
        "clean": clean,
        "blocked": by_outcome.get("blocked", 0),
        "errored": errored,
        "partial": by_outcome.get("partial", 0),
        "ratio": ratio,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", default=os.environ.get("AIGENT_VAULT", os.path.expanduser("~/.aigent")))
    ap.add_argument("--days", type=int, default=None,
                    help="filter to last N days; default all-time")
    args = ap.parse_args()

    ledger = Path(args.vault) / "memory" / "AGENT_FITNESS.md"
    rows = parse_ledger(ledger)

    if not rows:
        print("=== /agent-fitness report ===")
        print("(no dispatches in ledger — run /agent-fitness extract first)")
        return 0

    all_time = rows
    last_30 = filter_window(rows, 30)
    last_7 = filter_window(rows, 7)

    print(f"=== /agent-fitness report — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} ===")
    print()
    print(f"Total dispatches: all-time={len(all_time)}, last_30d={len(last_30)}, last_7d={len(last_7)}")
    print()

    # Per-agent calibration (use the requested window)
    window_rows = filter_window(rows, args.days) if args.days else rows
    agents = sorted(set(r["agent"] for r in window_rows))

    print(f"Per-agent calibration ({'last ' + str(args.days) + 'd' if args.days else 'all-time'}):")
    print("  Fields: agent, total, clean, blocked, errored, partial, ratio")
    for a in agents:
        c = calibration(window_rows, a)
        ratio_str = f"{c['ratio']:.0%}" if c["ratio"] is not None else "n/a"
        print(
            f"  agent={inert(a, 120)} total={c['total']} clean={c['clean']} "
            f"blocked={c['blocked']} errored={c['errored']} partial={c['partial']} "
            f"ratio={ratio_str}"
        )
    print()

    # Recent outcome trend per agent (last 10 dispatches)
    print("Recent trend (last 10 dispatches per agent):")
    by_agent = defaultdict(list)
    for r in window_rows:
        by_agent[r["agent"]].append(r["outcome"])
    for a in sorted(by_agent.keys()):
        recent = by_agent[a][-10:]
        c = Counter(recent)
        trend = " ".join(f"{o[0]}{c[o]}" for o in ("clean", "blocked", "errored", "partial") if c.get(o))
        print(f"  agent={inert(a, 120)} last_{len(recent)}: {trend}")
    print()

    # Repeat-blocker detection
    blocked_agents = [(a, calibration(window_rows, a)["blocked"]) for a in agents]
    repeat_blockers = [(a, n) for a, n in blocked_agents if n >= 2]
    if repeat_blockers:
        print("⚠ Repeat-blocker callouts (>=2 blocks in window):")
        for a, n in repeat_blockers:
            print(f"  agent={inert(a, 120)}: {n} blocked dispatches — investigate the failure mode")
        print()

    # Top failing (agent, task) pairs
    failing = [(r["agent"], r["task"][:40], r["outcome"], r["notes"])
               for r in window_rows if r["outcome"] in ("blocked", "errored", "partial")]
    if failing:
        # Group by (agent, task-head) and count
        pair_counts = Counter((a, t) for a, t, _, _ in failing)
        top3 = pair_counts.most_common(3)
        print("Top failing (agent, task) pairs:")
        for (a, t), n in top3:
            print(f"  {n}× agent={inert(a, 120)} task={inert(t, 80)}")
    else:
        print("No failures in window — all dispatches clean.")

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"[agent-fitness-report] error: {inert(e)}", file=sys.stderr)
        sys.exit(1)
