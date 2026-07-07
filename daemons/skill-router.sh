#!/bin/bash
# skill-router.sh — aigent-OS Skill Router (Phase 2)
# Reads user prompt from stdin, scores each active SkillCard against it via
# keyword matching on the `triggers` array, and emits a structured Caddy hint
# for the top match if it scores >= 2.
#
# Output format:
#   [CADDY:skill] MATCH — /skill-name (description) — matched on: [word1, word2]. Pantheon: Agent. Model: preference.
#
# Spec: [[concepts/aigent-OS Refactor Spec]] Phase 2
# Contract: best-effort. All errors go to DAEMON_ERR_LOG. Never blocks caddy.sh.

ROOT="${AIGENT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DAEMON_ERR_LOG="${DAEMON_ERR_LOG:-$ROOT/memory/.daemon-errors.log}"

# Prefer the new typed SkillCard index; fall back to repo copy (old flat-array format).
# New index lives at ~/.claude/skills/skill-index.json and has the {_meta, cards:[]}
# structure with model_preference + pantheon_agent fields.
_DEFAULT_INDEX="$HOME/.claude/skills/skill-index.json"
_REPO_INDEX="$ROOT/.claude/skill-index.json"
if [ -f "$_DEFAULT_INDEX" ]; then
  INDEX="${SKILL_INDEX:-$_DEFAULT_INDEX}"
else
  INDEX="${SKILL_INDEX:-$_REPO_INDEX}"
fi

# Read prompt from stdin
INPUT=$(cat 2>/dev/null)
[ -z "$INPUT" ] && exit 0
[ -f "$INDEX" ] || exit 0

INPUT="$INPUT" INDEX="$INDEX" python3 <<'PYEOF' 2>>"$DAEMON_ERR_LOG" || exit 0
import os, sys, json, re

raw = os.environ.get("INPUT", "")
index_path = os.environ.get("INDEX", "")

# Normalise Git-Bash /c/Users/... paths to C:/Users/... on Windows
if os.name == "nt" and len(index_path) > 2 and index_path[0] == "/" and index_path[2] == "/" and index_path[1].isalpha():
    index_path = index_path[1].upper() + ":" + index_path[2:]

# ── Parse prompt ──────────────────────────────────────────────────────────────
try:
    payload = json.loads(raw) if raw.strip().startswith("{") else {"prompt": raw}
except Exception:
    payload = {"prompt": raw}

prompt = payload.get("prompt") or payload.get("user_prompt") or raw
if not prompt:
    sys.exit(0)

prompt_lower = prompt.lower()

# ── Load skill index ──────────────────────────────────────────────────────────
try:
    with open(index_path, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception as e:
    print(f"[skill-router] index_load_failed path={index_path!r} err={e}", file=sys.stderr)
    sys.exit(0)

# Handle both formats:
#   new: {"_meta": ..., "cards": [...]}  — SkillCard objects
#   old: [{"name": ..., "triggers": ..., "why": ...}, ...]  — legacy flat array
if isinstance(data, list):
    cards = data
elif isinstance(data, dict):
    cards = data.get("cards", [])
else:
    cards = []

if not cards:
    sys.exit(0)

# ── Score each active card ────────────────────────────────────────────────────
# Multi-word trigger phrases score 3; single-word boundary matches score 1.
# Minimum threshold: 2 points (prevents single-word false positives on generic
# terms like "release" or "video" appearing in unrelated prompts).
scores = []
for card in cards:
    if not card.get("active", True):
        continue
    name        = card.get("name", "")
    # new format uses "description"; old format uses "why"
    description = card.get("description") or card.get("why", "")
    triggers    = [t.lower() for t in card.get("triggers", [])]
    model       = card.get("model_preference", "sonnet")
    pantheon    = card.get("pantheon_agent")

    score   = 0
    matched = []
    for trig in triggers:
        if not trig:
            continue
        if " " in trig:
            if trig in prompt_lower:
                score += 3
                matched.append(trig)
        else:
            if re.search(r"\b" + re.escape(trig) + r"\b", prompt_lower):
                score += 1
                matched.append(trig)

    if score >= 2:
        scores.append((score, name, description, matched, model, pantheon))

# ── Emit top match only (avoid hint flooding) ─────────────────────────────────
if not scores:
    sys.exit(0)

scores.sort(key=lambda x: x[0], reverse=True)
best_score, best_name, best_desc, best_matched, best_model, best_pantheon = scores[0]

pantheon_str = f"Pantheon: {best_pantheon}." if best_pantheon else "Pantheon: none."
matched_str  = ", ".join(best_matched[:4])   # cap to 4 so line stays readable

print(
    f"[CADDY:skill] MATCH — /{best_name} ({best_desc}) — "
    f"matched on: [{matched_str}]. {pantheon_str} Model: {best_model}."
)
PYEOF

exit 0
