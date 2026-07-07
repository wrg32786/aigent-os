#!/bin/bash
# tier2-report.sh — Tier 2 pattern observability summary
# Reads memory/.tier2-observations.log, outputs a false-positive table for last 7 days.
# Run manually after /digest or any session where Tier 2 patterns fired.
#
# Usage: bash daemons/tier2-report.sh
#
# Output format:
#   Pattern              | Fires | Banked | False-positive rate
#   correction_drop      |    23 |      0 | 100%
#   ...
#
# Spec: [[concepts/Somatic v0.5.x polish — Tier 2 observability]]

ROOT="${AIGENT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
TIER2_OBS_LOG="$ROOT/memory/.tier2-observations.log"

# Git-Bash path fix for Python
ROOT_PY="$ROOT"
TIER2_OBS_LOG_PY="$TIER2_OBS_LOG"

python3 - "$TIER2_OBS_LOG_PY" <<'PYEOF'
import sys, os, re
from datetime import datetime, timezone, timedelta
from collections import defaultdict

log_path = sys.argv[1]

# Git-Bash → Windows path translation
def fix_path(path):
    if os.name == "nt" and len(path) > 2 and path[0] == "/" and path[2] == "/" and path[1].isalpha():
        return path[1].upper() + ":" + path[2:]
    return path

log_path = fix_path(log_path)

if not os.path.exists(log_path):
    print("No tier2 observations log found. Run a session with Tier 2 patterns to populate it.")
    print(f"Expected: {log_path}")
    sys.exit(0)

now_utc = datetime.now(timezone.utc)
cutoff = now_utc - timedelta(days=7)

# Log line format:
#   2026-05-04T11:23:45Z | pattern_name | confidence | <80 char snippet> | banked=yes/no
line_re = re.compile(
    r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|.*?\|\s*banked=(yes|no)\s*$"
)

# { pattern_name: {"fires": int, "banked": int, "confidence": str} }
stats = defaultdict(lambda: {"fires": 0, "banked": 0, "confidence": ""})

skipped_old = 0
parse_errors = 0

with open(log_path, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        m = line_re.match(line)
        if not m:
            parse_errors += 1
            continue
        ts_str, pattern_name, confidence, banked = m.groups()
        try:
            ts = datetime.strptime(ts_str, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            parse_errors += 1
            continue
        if ts < cutoff:
            skipped_old += 1
            continue
        stats[pattern_name]["fires"] += 1
        stats[pattern_name]["confidence"] = confidence
        if banked == "yes":
            stats[pattern_name]["banked"] += 1

if not stats:
    print("No Tier 2 observations in the last 7 days.")
    if skipped_old:
        print(f"({skipped_old} older entries skipped)")
    sys.exit(0)

# Sort by false-positive rate descending (worst offenders first)
def fp_rate(row):
    fires = row["fires"]
    banked = row["banked"]
    if fires == 0:
        return 0.0
    return (fires - banked) / fires

sorted_patterns = sorted(stats.items(), key=lambda kv: fp_rate(kv[1]), reverse=True)

# Column widths
col_pattern = max(len("Pattern"), max(len(k) for k in stats)) + 2
col_fires   = max(len("Fires"), 5) + 2
col_banked  = max(len("Banked"), 6) + 2
col_fp      = len("False-positive rate") + 2

header = (
    f"{'Pattern':<{col_pattern}}| {'Fires':>{col_fires-2}} | {'Banked':>{col_banked-2}} | False-positive rate"
)
divider = "-" * len(header)

print()
print(f"Tier 2 Pattern Report — last 7 days (cutoff: {cutoff.strftime('%Y-%m-%d')})")
print(divider)
print(header)
print(divider)

for pattern_name, row in sorted_patterns:
    fires  = row["fires"]
    banked = row["banked"]
    fp     = fp_rate({"fires": fires, "banked": banked})
    fp_pct = f"{fp*100:.0f}%"
    print(f"{pattern_name:<{col_pattern}}| {fires:>{col_fires-2}} | {banked:>{col_banked-2}} | {fp_pct}")

print(divider)
total_fires  = sum(r["fires"]  for r in stats.values())
total_banked = sum(r["banked"] for r in stats.values())
total_fp = fp_rate({"fires": total_fires, "banked": total_banked})
print(f"{'TOTAL':<{col_pattern}}| {total_fires:>{col_fires-2}} | {total_banked:>{col_banked-2}} | {total_fp*100:.0f}%")
print()

if parse_errors:
    print(f"Warning: {parse_errors} malformed log line(s) skipped.")
if skipped_old:
    print(f"({skipped_old} entries older than 7 days excluded.)")
PYEOF
