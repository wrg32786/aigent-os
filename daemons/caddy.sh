#!/usr/bin/env bash
# aigent-OS skill router for Claude Code UserPromptSubmit hooks.
# Best-effort and non-blocking: useful hints go to stdout; failures go to the
# local daemon log and never prevent the user's prompt from continuing.

set -u

ROOT="${AIGENT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO_INDEX="$ROOT/.claude/skill-index.json"
GLOBAL_INDEX="$HOME/.claude/skills/skill-index.json"
INDEX="$REPO_INDEX"
[[ -f "$INDEX" ]] || INDEX="$GLOBAL_INDEX"
[[ -f "$INDEX" ]] || exit 0

DAEMON_ERR_LOG="$ROOT/memory/.daemon-errors.log"
mkdir -p "$(dirname "$DAEMON_ERR_LOG")" "$ROOT/.aigent/cache" 2>/dev/null || true

INPUT="$(cat 2>/dev/null)"
[[ -n "$INPUT" ]] || exit 0
INPUT_LOWER="$(printf '%s' "$INPUT" | tr '[:upper:]' '[:lower:]')"

MUTES_FILE="$ROOT/memory/CADDY_MUTES.json"
class_muted() {
  local class="$1"
  [[ -f "$MUTES_FILE" ]] || return 1
  command -v python3 >/dev/null 2>&1 || return 1
  CLASS="$class" MUTES_FILE="$MUTES_FILE" python3 <<'PY' 2>>"$DAEMON_ERR_LOG"
import json
import os
import re
import sys
from datetime import datetime, timezone

path = os.environ["MUTES_FILE"]
if os.name == "nt" and re.match(r"^/[A-Za-z]/", path):
    path = f"{path[1].upper()}:{path[2:]}"
try:
    with open(path, encoding="utf-8") as handle:
        mutes = json.load(handle)
except Exception as exc:
    print(f"[caddy:class_muted] {exc}", file=sys.stderr)
    raise SystemExit(1)

now = datetime.now(timezone.utc)
def active(entry):
    if not isinstance(entry, dict) or not entry.get("muted_until"):
        return False
    try:
        return datetime.fromisoformat(entry["muted_until"].replace("Z", "+00:00")) > now
    except (TypeError, ValueError):
        return False

name = os.environ["CLASS"]
raise SystemExit(0 if active(mutes.get(name)) or active(mutes.get("all")) else 1)
PY
}

# Optional reminders are opt-in because public defaults must not assume one
# maintainer's model policy or locally installed plugins.
if [[ "${AIGENT_ROUTING_REMINDER:-0}" == "1" ]]; then
  class_muted routing || printf '%s\n' '[CADDY:routing] ROUTE — Use the least expensive model that can reliably complete the task; reserve frontier reasoning for strategy and synthesis.'
fi

if printf '%s' "$INPUT_LOWER" | grep -qE \
  'where (does|do|did|is|are|should) .*(live|go|sit|exist)|which (repo|folder|directory)|who (handles|owns|builds)|what.s the rule (for|about)|i don.t know where|i.m not sure where|i.m lost|where do i start|how do i find'; then
  class_muted routing || printf '%s\n' '[CADDY:routing] /orient — Load the map before guessing where a file, rule, or owner lives.'
fi

if printf '%s' "$INPUT_LOWER" | grep -qE \
  '(post|send|reply|relay|share|tell|message|note) .*(channel|team|comms)|in comms|to comms'; then
  class_muted routing || printf '%s\n' '[CADDY:routing] STYLE — Match the configured team voice. Keep the message short, specific, and free of generic AI scaffolding.'
fi

if [[ "${AIGENT_ENABLE_REMINDB:-0}" == "1" ]] && printf '%s' "$INPUT_LOWER" | grep -qE \
  '(read|load|recall|find|search|query|look up|fetch) .*(vault|memory|notes?|concepts?)|memory query|vault query|recall|catch me up'; then
  class_muted memory || printf '%s\n' '[CADDY:memory] MEMDB — Use the configured remindb MCP tools for known-topic vault queries.'
fi

if [[ "${AIGENT_ENABLE_CONTEXT_MODE:-0}" == "1" ]] && printf '%s' "$INPUT_LOWER" | grep -qE \
  'cat .*(log|output|json|txt|md)|head -|tail -|grep -A|grep -B|find .* -exec|wc -l|jq |awk |sed |xargs|process .*(json|log|csv|output)|analyze .*(log|output|dump)|fetch .*(url|page|docs)'; then
  class_muted context || printf '%s\n' '[CADDY:context] CTX — Route large-output operations through the configured context-mode tools.'
fi

if printf '%s' "$INPUT_LOWER" | grep -qE \
  '/digest|review.*candidates?|stage.*memory|promote .*(candidate|memory|note)|memory candidates?|new rule:|from now on,?|remember that|rule:'; then
  class_muted memory || printf '%s\n' '[CADDY:memory] DIGEST — Memory candidates may be staged. Run /digest to review promote, skip, and supersede decisions.'
fi

if [[ -x "$ROOT/daemons/memory-capture.sh" ]]; then
  printf '%s' "$INPUT" | AIGENT_ROOT="$ROOT" bash "$ROOT/daemons/memory-capture.sh" 2>>"$DAEMON_ERR_LOG" || true
fi

if printf '%s' "$INPUT_LOWER" | grep -qE \
  'context (getting|is) long|before compact|preserve context|save context|structured handoff|resume prompt|task done|milestone shipped|/context-capsule|/capsule'; then
  class_muted context || printf '%s\n' '[CADDY:context] CAPSULE — Preserve a resume-ready context capsule before compaction or handoff.'
fi

if printf '%s' "$INPUT_LOWER" | grep -qE \
  'how am i doing|body check|body state|vital signs|/body-check|pressure check|context pressure|token pressure|where are we'; then
  class_muted body || printf '%s\n' '[CADDY:body] BODY-CHECK — Compose current context, memory, decision, delegation, and token pressure.'
fi

LEDGER="$ROOT/memory/SKILL_LEDGER.md"
CHAINS="$ROOT/memory/SKILL_CHAINS.md"

if command -v python3 >/dev/null 2>&1; then
  INPUT="$INPUT" INDEX="$INDEX" LEDGER="$LEDGER" CHAINS="$CHAINS" ROOT="$ROOT" python3 <<'PY' 2>>"$DAEMON_ERR_LOG" || true
import json
import os
import re
from pathlib import Path

raw = os.environ.get("INPUT", "")
try:
    payload = json.loads(raw) if raw.lstrip().startswith("{") else {"prompt": raw}
except json.JSONDecodeError:
    payload = {"prompt": raw}

prompt = payload.get("prompt") or payload.get("user_prompt") or ""
if not isinstance(prompt, str) or not prompt.strip():
    raise SystemExit(0)
prompt_lower = prompt.lower()

try:
    with open(os.environ["INDEX"], encoding="utf-8") as handle:
        skills = json.load(handle)
except (OSError, json.JSONDecodeError, TypeError):
    raise SystemExit(0)
if not isinstance(skills, list):
    raise SystemExit(0)

scores = []
for skill in skills:
    if not isinstance(skill, dict):
        continue
    name = str(skill.get("name", ""))
    score = 0
    matched = []
    for value in skill.get("triggers", []):
        trigger = str(value).lower().strip()
        if not trigger:
            continue
        hit = trigger in prompt_lower if " " in trigger else re.search(r"\b" + re.escape(trigger) + r"\b", prompt_lower)
        if hit:
            score += 3 if " " in trigger else 1
            matched.append(trigger)
    if score:
        scores.append((score, name, str(skill.get("why", "")), matched))

scores.sort(key=lambda item: (-item[0], item[1]))
top = [item for item in scores if item[0] >= 2][:2]
for _, name, why, _ in top:
    print(f"[CADDY] /{name} - {why}")

stopwords = {
    "the", "a", "an", "is", "are", "was", "were", "be", "to", "of", "and", "in", "for", "on",
    "with", "this", "that", "it", "do", "my", "me", "i", "we", "our", "can", "how", "what",
    "when", "where", "why", "please", "should", "would", "could",
}
words = [word for word in re.findall(r"\w+", prompt_lower) if word not in stopwords and len(word) > 2]

if not top:
    taxonomy_matches = []
    ledger_path = os.environ.get("LEDGER", "")
    pattern = re.compile(r"^- `([^`]+)` — (.+?) — (.+)$")
    try:
        for line in Path(ledger_path).read_text(encoding="utf-8").splitlines():
            match = pattern.match(line.strip())
            if not match:
                continue
            path_value, description, skill_ref = match.groups()
            path_tokens = path_value.replace(".", " ").lower().split()
            description_tokens = re.findall(r"\w+", description.lower())
            score = sum((2 if word in path_tokens else 0) + (1 if word in description_tokens else 0) for word in words)
            if score >= 3:
                taxonomy_matches.append((score, path_value, description, skill_ref))
    except OSError:
        pass

    taxonomy_matches.sort(key=lambda item: (-item[0], item[1]))
    if taxonomy_matches:
        _, path_value, description, skill_ref = taxonomy_matches[0]
        print(f"[CADDY:taxonomy] {skill_ref} ({path_value}) — {description} — [LEDGER]")
    else:
        session_id = re.sub(r"[^A-Za-z0-9_.-]", "_", str(payload.get("session_id") or "unknown"))[:80]
        flag = Path(os.environ["ROOT"]) / ".aigent" / "cache" / f"caddy-gap-{session_id}"
        if not flag.exists():
            print("[CADDY:taxonomy] No skill match — run /skill-recall to log this gap")
            try:
                flag.parent.mkdir(parents=True, exist_ok=True)
                flag.write_text("1\n", encoding="utf-8")
            except OSError:
                pass

chains_path = os.environ.get("CHAINS", "")
try:
    for line in Path(chains_path).read_text(encoding="utf-8").splitlines():
        if "|" not in line or line.strip().startswith(("|---", "| Date")):
            continue
        parts = [part.strip() for part in line.split("|")]
        if len(parts) < 4:
            continue
        objective, chain = parts[2].lower(), parts[3]
        overlap = sum(1 for word in words if word in re.findall(r"\w+", objective))
        if overlap >= 3 and chain:
            print(f"[CADDY:chain] Prior chain for a similar objective: {chain} (see SKILL_CHAINS)")
            break
except OSError:
    pass
PY
fi

if [[ -x "$ROOT/daemons/skill-router.sh" ]]; then
  SKILL_HINT="$(printf '%s' "$INPUT" | AIGENT_ROOT="$ROOT" DAEMON_ERR_LOG="$DAEMON_ERR_LOG" bash "$ROOT/daemons/skill-router.sh" 2>>"$DAEMON_ERR_LOG")"
  [[ -z "$SKILL_HINT" ]] || printf '%s\n' "$SKILL_HINT"
fi

exit 0
