#!/bin/bash
# skill-router.sh — aigent-OS skill router.
# Reads user prompt from stdin, scores each active SkillCard against it via
# keyword matching on the `triggers` array, and emits a structured Caddy hint
# for the top match if it scores >= 2.
#
# Output format:
#   [CADDY:skill] MATCH — /skill-name (description) — matched on: [word1, word2]. Model: preference.
#
# Contract: best-effort. All errors go to DAEMON_ERR_LOG. Never blocks caddy.sh.

ROOT="${AIGENT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
if [ -z "${DAEMON_ERR_LOG:-}" ]; then
# Memory root: resolved by daemons/memory-root.cjs, the one resolver every core
# reader and writer shares (declared in .aigent/state.json, default vault/memory).
# A broken declaration is reported on stderr and this best-effort script exits
# without writing anywhere.
SELF_DIR=$(dirname "$0")
SELF_DIR=$(cd "$SELF_DIR" && pwd)
. "$SELF_DIR/memory-root.sh"
MEMORY_ROOT="$(aigent_memory_root "${AIGENT_STATE_HOME_DIR:-$ROOT}" 2>&1)" \
  || { printf '%s\n' "$MEMORY_ROOT" >&2; exit 0; }
  DAEMON_ERR_LOG="$MEMORY_ROOT/.daemon-errors.log"
fi

# Prefer the new typed SkillCard index; fall back to repo copy (old flat-array format).
# The optional global index uses the {_meta, cards:[]} SkillCard structure.
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

INPUT="$INPUT" INDEX="$INDEX" ROOT="$ROOT" python3 <<'PYEOF' 2>>"$DAEMON_ERR_LOG" || exit 0
import os, sys, json, re

raw = os.environ.get("INPUT", "")
index_path = os.environ.get("INDEX", "")
root = os.environ.get("ROOT", "")

# Normalise Git-Bash /c/Users/... paths to C:/Users/... on Windows
if os.name == "nt" and len(index_path) > 2 and index_path[0] == "/" and index_path[2] == "/" and index_path[1].isalpha():
    index_path = index_path[1].upper() + ":" + index_path[2:]
if os.name == "nt" and len(root) > 2 and root[0] == "/" and root[2] == "/" and root[1].isalpha():
    root = root[1].upper() + ":" + root[2:]

# ── Parse prompt ──────────────────────────────────────────────────────────────
try:
    payload = json.loads(raw) if raw.strip().startswith("{") else {"prompt": raw}
except Exception:
    payload = {"prompt": raw}

prompt = payload.get("prompt") or payload.get("user_prompt") or raw
if not prompt:
    sys.exit(0)

prompt_lower = prompt.lower()

LINE_BREAKING = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")
def inert(value, maximum=500):
    rendered = re.sub(r"[ \t]+", " ", LINE_BREAKING.sub(" ", str("" if value is None else value))).strip()
    if len(rendered) > maximum:
        rendered = f"{rendered[:maximum]}…[+{len(rendered) - maximum} chars]"
    return json.dumps(rendered, ensure_ascii=True)

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
    name        = str(card.get("name", ""))
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", name):
        continue
    # new format uses "description"; old format uses "why"
    description = card.get("description") or card.get("why", "")
    triggers    = [t.lower() for t in card.get("triggers", [])]
    model       = card.get("model_preference", "sonnet")

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
        scores.append((score, name, description, matched, model))

# ── Emit top match only (avoid hint flooding) ─────────────────────────────────
if not scores:
    sys.exit(0)

scores.sort(key=lambda x: x[0], reverse=True)
best_score, best_name, best_desc, best_matched, best_model = scores[0]

# These skills mutate durable judgment-bearing state. Always route their common
# names to the unique public aliases that pin the close-parity contracts. If an
# alias disappears, fail closed instead of suggesting an ambiguous writer.
aliases = {
    "nightly": "nightly-close-parity",
    "meta-improve": "meta-improve-vault",
}
alias = aliases.get(best_name)
if alias:
    alias_path = os.path.join(root, "skills", alias, "SKILL.md")
    if os.path.isfile(alias_path):
        best_name = alias
    else:
        print(f"[skill-router] alias_missing source={best_name} target={alias} path={alias_path}", file=sys.stderr)
        sys.exit(0)

matched_str  = ", ".join(best_matched[:4])   # cap to 4 so line stays readable

print(
    f"[CADDY:skill] MATCH — /{best_name} description={inert(best_desc)} — "
    f"matched_on={inert(matched_str, 240)} model={inert(best_model, 80)}."
)
PYEOF

exit 0
