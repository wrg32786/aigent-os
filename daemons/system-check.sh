#!/bin/bash
# system-check.sh — Somatic v0.4.3 reflection organ.
# Smoke-tests every wired path: skills, daemons, state files, capsules, mirror, error log.
# Output: green/red report per path. Exit 0 if all PASS, 1 if any FAIL.

VAULT="${AIGENT_VAULT:-${AIGENT_ROOT:-$HOME/.aigent}}"
PUBLIC="${AIGENT_PUBLIC:-$HOME/.aigent-os}"
DAEMON_ERR_LOG="$VAULT/memory/.daemon-errors.log"

PASS=0
FAIL=0
INFO=0
REPORT=""

ck() {
  local label="$1"; local ok="$2"; local detail="$3"
  if [ "$ok" = "PASS" ]; then
    REPORT+="✓ $label"$'\n'
    PASS=$((PASS+1))
  elif [ "$ok" = "FAIL" ]; then
    REPORT+="✗ $label — $detail"$'\n'
    FAIL=$((FAIL+1))
  else
    REPORT+="ℹ $label — $detail"$'\n'
    INFO=$((INFO+1))
  fi
}

echo "=== /system-check report — $(date -Iseconds) ==="

# --- Skills (v0.4 → v0.5.0 wired set) ---
SKILLS=(body-check digest context-capsule caddy-mute system-check sweep-now capsule-compact agent-fitness)
SK_OK=0; SK_TOT=${#SKILLS[@]}
SK_FAIL_LIST=""
for s in "${SKILLS[@]}"; do
  if [ -f "$VAULT/.claude/skills/$s/SKILL.md" ]; then
    SK_OK=$((SK_OK+1))
  else
    SK_FAIL_LIST+="$s "
  fi
done
[ "$SK_OK" = "$SK_TOT" ] && ck "Skills ($SK_OK/$SK_TOT wired)" PASS || ck "Skills ($SK_OK/$SK_TOT wired)" FAIL "missing: $SK_FAIL_LIST"

# --- Daemons (shell + python + node) ---
DAEMONS=(caddy.sh memory-capture.sh sync-usage.sh log-token-usage.sh system-check.sh)
D_OK=0; D_TOT=${#DAEMONS[@]}
D_FAIL_LIST=""
for d in "${DAEMONS[@]}"; do
  if [ -f "$VAULT/daemons/$d" ] && bash -n "$VAULT/daemons/$d" 2>/dev/null; then
    D_OK=$((D_OK+1))
  else
    D_FAIL_LIST+="$d "
  fi
done
# compute-heat.js
HEAT_OK="FAIL"
if [ -f "$VAULT/daemons/memory-heat/compute-heat.js" ]; then
  node --check "$VAULT/daemons/memory-heat/compute-heat.js" 2>/dev/null && HEAT_OK="PASS"
fi
# Python daemons (v0.4.5 + v0.5.0)
PY_DAEMONS=(capsule-compact.py agent-fitness-extract.py)
PY_OK=0; PY_TOT=${#PY_DAEMONS[@]}
PY_FAIL=""
for p in "${PY_DAEMONS[@]}"; do
  if [ -f "$VAULT/daemons/$p" ] && python3 -c "import ast; ast.parse(open(r'$VAULT/daemons/$p').read())" 2>/dev/null; then
    PY_OK=$((PY_OK+1))
  else
    PY_FAIL+="$p "
  fi
done
TOTAL_D=$((D_TOT+1+PY_TOT))
HEAT_BIT=0; [ "$HEAT_OK" = "PASS" ] && HEAT_BIT=1
TOTAL_OK=$((D_OK+HEAT_BIT+PY_OK))
if [ "$TOTAL_OK" = "$TOTAL_D" ]; then
  ck "Daemons ($TOTAL_OK/$TOTAL_D parse green)" PASS
else
  ck "Daemons ($TOTAL_OK/$TOTAL_D parse green)" FAIL "$D_FAIL_LIST compute-heat:$HEAT_OK $PY_FAIL"
fi

# --- State files ---
ST_OK=0; ST_TOT=7
ST_FAIL=""
# BODY_STATE
python3 -c "import json; d=json.load(open(r'$VAULT/memory/BODY_STATE.json')); assert '_schema' in d and 'state' in d" 2>/dev/null && ST_OK=$((ST_OK+1)) || ST_FAIL+="BODY_STATE "
# HEAT_INDEX
python3 -c "import json,os,time; p=r'$VAULT/memory/HEAT_INDEX.json'; d=json.load(open(p)); assert 'hot_top_20' in d; assert (time.time()-os.path.getmtime(p))/86400 < 7" 2>/dev/null && ST_OK=$((ST_OK+1)) || ST_FAIL+="HEAT_INDEX "
# CADDY_MUTES (optional but if present must be valid)
if [ -f "$VAULT/memory/CADDY_MUTES.json" ]; then
  python3 -c "import json; json.load(open(r'$VAULT/memory/CADDY_MUTES.json'))" 2>/dev/null && ST_OK=$((ST_OK+1)) || ST_FAIL+="CADDY_MUTES "
else
  ST_OK=$((ST_OK+1))  # absent is fine
fi
# MEMORY_CANDIDATES
[ -f "$VAULT/memory/MEMORY_CANDIDATES.md" ] && grep -q "## Candidates" "$VAULT/memory/MEMORY_CANDIDATES.md" && ST_OK=$((ST_OK+1)) || ST_FAIL+="MEMORY_CANDIDATES "
# HESTIA_SWEEP_LOG
[ -f "$VAULT/memory/HESTIA_SWEEP_LOG.md" ] && ST_OK=$((ST_OK+1)) || ST_FAIL+="HESTIA_SWEEP_LOG "
# AGENT_FITNESS (v0.5.0)
[ -f "$VAULT/memory/AGENT_FITNESS.md" ] && grep -q "^| Date | Session" "$VAULT/memory/AGENT_FITNESS.md" && ST_OK=$((ST_OK+1)) || ST_FAIL+="AGENT_FITNESS "
# capsules dir + at least one valid capsule
CAP_DIR="$VAULT/memory/capsules"
if [ -d "$CAP_DIR" ]; then
  CAP_OK=$(ls "$CAP_DIR"/*.md 2>/dev/null | wc -l)
  [ "$CAP_OK" -gt 0 ] && ST_OK=$((ST_OK+1)) || ST_FAIL+="capsules "
else
  ST_FAIL+="capsules-dir "
fi
[ "$ST_OK" = "$ST_TOT" ] && ck "State files ($ST_OK/$ST_TOT valid)" PASS || ck "State files ($ST_OK/$ST_TOT valid)" FAIL "$ST_FAIL"

# --- Capsules health (frontmatter sanity) ---
CAP_BAD=$(python3 -c "
import os, re
d = r'$VAULT/memory/capsules'
bad = []
if os.path.isdir(d):
    for f in os.listdir(d):
        if not f.endswith('.md'): continue
        with open(os.path.join(d, f)) as fh:
            t = fh.read()
        m = re.match(r'^---\n(.*?)\n---', t, re.DOTALL)
        if not m:
            bad.append(f+':no_fm')
            continue
        fm = m.group(1)
        if 'status:' not in fm or 'capsule_id:' not in fm:
            bad.append(f+':missing_required')
            continue
        st = re.search(r'^status:\s*(\w+)', fm, re.M)
        if st and st.group(1) not in ('active','resumed','resolved'):
            bad.append(f+':bad_status')
print(','.join(bad) if bad else 'OK')
" 2>/dev/null)
if [ "$CAP_BAD" = "OK" ]; then
  CAP_COUNT=$(ls "$CAP_DIR"/*.md 2>/dev/null | wc -l)
  ck "Capsules ($CAP_COUNT healthy)" PASS
else
  ck "Capsules" FAIL "$CAP_BAD"
fi

# --- Mirror discipline ---
MIRROR_BAD=""
# Files mirrored vault ↔ public aigent-os. PRIVATE-by-design files excluded:
#   - daemons/sync-usage.sh (the principal's API key)
#   - daemons/log-token-usage.sh (aigent-OS-specific vault path)
for f in skills/body-check/SKILL.md skills/digest/SKILL.md skills/context-capsule/SKILL.md skills/caddy-mute/SKILL.md skills/system-check/SKILL.md skills/sweep-now/SKILL.md skills/capsule-compact/SKILL.md skills/agent-fitness/SKILL.md daemons/caddy.sh daemons/memory-capture.sh daemons/system-check.sh daemons/capsule-compact.py daemons/agent-fitness-extract.py; do
  L="$VAULT/.claude/$f"
  [[ "$f" == daemons/* ]] && L="$VAULT/$f"
  P="$PUBLIC/$f"
  [[ "$f" == skills/* ]] && P="$PUBLIC/${f}"  # public uses skills/ at root
  if [ -f "$L" ] && [ -f "$P" ]; then
    if ! diff -q "$L" "$P" >/dev/null 2>&1; then
      MIRROR_BAD+="$f "
    fi
  elif [ -f "$L" ] && [ ! -f "$P" ]; then
    MIRROR_BAD+="$f(missing-public) "
  fi
done
[ -z "$MIRROR_BAD" ] && ck "Mirror discipline (vault ↔ public)" PASS || ck "Mirror discipline" FAIL "$MIRROR_BAD"

# --- Daemon error log surfacing ---
if [ -f "$DAEMON_ERR_LOG" ]; then
  ERR_COUNT=$(wc -l < "$DAEMON_ERR_LOG")
  if [ "$ERR_COUNT" -gt 0 ]; then
    TOP=$(tail -5 "$DAEMON_ERR_LOG" | sed 's/^/    /')
    ck "Daemon errors: $ERR_COUNT entries (recent below)" INFO "$(echo; echo "$TOP")"
  else
    ck "Daemon errors: 0 entries (clean)" PASS
  fi
else
  ck "Daemon errors: log absent (nothing logged yet)" INFO "expected on first run"
fi

# --- Output ---
echo ""
echo "$REPORT"
echo "SUMMARY: $PASS PASS / $FAIL FAIL / $INFO INFO"

[ "$FAIL" = "0" ] && exit 0 || exit 1
