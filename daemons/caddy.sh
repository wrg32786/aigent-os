#!/usr/bin/env bash
# aigent-OS skill router for Claude Code UserPromptSubmit hooks.
# Best-effort and non-blocking: useful hints go to stdout; failures go to the
# local daemon log and never prevent the user's prompt from continuing.

set -u

ROOT="${AIGENT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# Memory root: resolved by daemons/memory-root.cjs, the one resolver every core
# reader and writer shares (declared in .aigent/state.json, default vault/memory).
# A broken declaration is reported on stderr and this best-effort script exits
# without writing anywhere.
CADDY_DIR=$(dirname "${BASH_SOURCE[0]}")
CADDY_DIR=$(cd "$CADDY_DIR" && pwd)
. "$CADDY_DIR/memory-root.sh"
# One spawn answers both: the memory root, and the ledgers root (the same
# tree on a declared seat, the pre-existing memory/ seed tree on a stock
# install, where the skill ledgers and the mute file ship).
MEMORY_ROOTS="$(aigent_memory_root "${AIGENT_STATE_HOME_DIR:-$ROOT}" --with-ledgers 2>&1)" \
  || { printf '%s\n' "$MEMORY_ROOTS" >&2; exit 0; }
MEMORY_ROOT="${MEMORY_ROOTS%%$'\n'*}"
LEDGERS_ROOT="${MEMORY_ROOTS#*$'\n'}"
REPO_INDEX="$ROOT/.claude/skill-index.json"
GLOBAL_INDEX="$HOME/.claude/skills/skill-index.json"
INDEX="$REPO_INDEX"
[[ -f "$INDEX" ]] || INDEX="$GLOBAL_INDEX"
[[ -f "$INDEX" ]] || exit 0

DAEMON_ERR_LOG="$MEMORY_ROOT/.daemon-errors.log"
mkdir -p "$(dirname "$DAEMON_ERR_LOG")" "$ROOT/.aigent/cache" 2>/dev/null || true

INPUT="$(cat 2>/dev/null)"
[[ -n "$INPUT" ]] || exit 0
INPUT_LOWER="$(printf '%s' "$INPUT" | tr '[:upper:]' '[:lower:]')"

MUTES_FILE="$LEDGERS_ROOT/CADDY_MUTES.json"
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

# Build intent. Unguarded by design: this is Standard 16, not one maintainer's
# policy, so it ships on by default like /orient and STYLE. Rungs 1 and 2 are
# the ones that actually get skipped, which is why the hint leads with them.
if printf '%s' "$INPUT_LOWER" | grep -qE \
  '\b(build|implement|create|scaffold|refactor|rewrite|introduce|wire up|set up|stand up)\b|\badd (a|an|another|some)? ?(feature|module|service|component|helper|wrapper|layer|abstraction|framework|handler|utility|endpoint|pipeline|system)\b|from scratch|new (module|service|helper|wrapper|abstraction|framework|system|layer)'; then
  class_muted routing || printf '%s\n' '[CADDY:routing] PONYTAIL — Walk the ladder before writing; stop at the first rung that holds: does this need to exist -> already in this codebase -> stdlib -> native platform -> installed dependency -> one line -> minimum that works. If a structure is defending a defect, fix the defect and DELETE the structure rather than patching it. Never cut validation, security, data-loss handling, or error propagation to make a diff smaller. Standard 16; full doctrine in vault/concepts/Ponytail Doctrine.md'
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

LEDGER="$LEDGERS_ROOT/SKILL_LEDGER.md"
CHAINS="$LEDGERS_ROOT/SKILL_CHAINS.md"

if command -v python3 >/dev/null 2>&1; then
  INPUT="$INPUT" INDEX="$INDEX" LEDGER="$LEDGER" CHAINS="$CHAINS" ROOT="$ROOT" python3 <<'PY' 2>>"$DAEMON_ERR_LOG" || true
import json
import os
import re
import sys
from datetime import date
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

# daemons/render_boundary.py is the repo's canonical Python render boundary
# (trust-boundary chokepoint #43), already imported by four sibling Python
# callers. Import it rather than re-deriving the escaping logic here.
sys.path.insert(0, os.path.join(os.environ["ROOT"], "daemons"))
try:
    from render_boundary import inert
except Exception:
    # Fail closed: never re-implement the function here. If the canonical
    # module cannot be imported, every render that depends on it becomes this
    # fixed marker instead of either crashing the hook or falling back to
    # unescaped persisted text.
    def inert(value, maximum=500):
        return json.dumps("[unavailable: render_boundary import failed]")

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
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", name):
        continue
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
    print(f"[CADDY] /{name} - {inert(why)}")

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
        print(
            f"[CADDY:taxonomy] skill={inert(skill_ref, 120)} path={inert(path_value, 200)} "
            f"description={inert(description)} — [LEDGER]"
        )
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

# A chain row has no session-id or live-authority concept the way a capsule
# does (P2's liveBootSession() has nothing to bind against here); the only
# staleness signal the Date column carries is its own age. A row's chain is
# reported as data either way -- this only changes whether it is presented as
# a live recommendation or flagged as a historical reference, per the
# trust-boundary #43 rule that stale/wrong-referent state must be reported,
# never silently treated as current.
# ponytail: fixed 90-day threshold, make configurable if false positives complain.
STALE_CHAIN_DAYS = 90
chains_path = os.environ.get("CHAINS", "")
try:
    for line in Path(chains_path).read_text(encoding="utf-8").splitlines():
        if "|" not in line or line.strip().startswith(("|---", "| Date")):
            continue
        parts = [part.strip() for part in line.split("|")]
        if len(parts) < 4:
            continue
        date_value, objective, chain = parts[1], parts[2].lower(), parts[3]
        overlap = sum(1 for word in words if word in re.findall(r"\w+", objective))
        if overlap >= 3 and chain:
            try:
                age_days = (date.today() - date.fromisoformat(date_value)).days
                if age_days < 0:
                    # A future-dated row is a stronger tampering/wrong-referent
                    # signal than a merely old one -- never render it as current.
                    provenance = f"recorded {date_value}, dated in the future -- reference only, verify before reuse"
                elif age_days > STALE_CHAIN_DAYS:
                    provenance = f"recorded {date_value}, {age_days}d ago -- STALE, reference only, verify before reuse"
                else:
                    provenance = f"recorded {date_value}"
            except ValueError:
                provenance = "recorded date unreadable -- reference only, verify before reuse"
            print(f"[CADDY:chain] {provenance}: prior chain for a similar objective {inert(chain)} (see SKILL_CHAINS)")
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
