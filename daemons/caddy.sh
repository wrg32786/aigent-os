#!/bin/bash
# caddy.sh - aigent-OS skill caddy
# Non-blocking UserPromptSubmit hook. Reads the prompt from stdin,
# matches against skill-index.json, and surfaces "[CADDY] /X - why" hints
# for skills that fit the task. Silent if no strong match. Never errors.
#
# Metaphor: like a golf caddy, Caddy hands the AIgent the right club for the shot.
# Non-blocking because suggestions are better than enforcement — avoids the
# error-spam failure mode of strict PreToolUse hooks.
#
# Expects AIGENT_ROOT env var to point to the repo root.
# Set this in your shell profile: export AIGENT_ROOT="/path/to/aigent-os"

ROOT="${AIGENT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# Prefer the bundled product index so aigent-OS is self-contained and surfaces ITS
# own skills — not whatever the operator happens to have in a personal global index.
# Fall back to a user global index only if the bundled one is somehow missing.
_REPO_INDEX="$ROOT/.claude/skill-index.json"
_GLOBAL_INDEX="$HOME/.claude/skills/skill-index.json"
if [ -f "$_REPO_INDEX" ]; then
  INDEX="$_REPO_INDEX"
else
  INDEX="$_GLOBAL_INDEX"
fi
# Daemon error log — silent-success guard. Errors append here instead of being
# swallowed by 2>/dev/null. Surface in /close audit or via /lint sweep.
DAEMON_ERR_LOG="$ROOT/memory/.daemon-errors.log"

[ -f "$INDEX" ] || exit 0

INPUT=$(cat 2>/dev/null)
[ -z "$INPUT" ] && exit 0

# ── Somatic v0.4.1: class-based mute system ───────────────────────────────
# Hints carry a class tag. CADDY_MUTES.json may suppress a class for a window.
# Classes: memory | context | body | routing | all
# Helper: class_muted <class> → exit 0 if muted (suppress hint), 1 if active.
MUTES_FILE="$ROOT/memory/CADDY_MUTES.json"
class_muted() {
  local class="$1"
  [ -f "$MUTES_FILE" ] || return 1
  CLASS="$class" MUTES_FILE="$MUTES_FILE" python3 <<'PYEOF' 2>>"$DAEMON_ERR_LOG"
import json, os, sys
from datetime import datetime, timezone
path = os.environ["MUTES_FILE"]
# Git-Bash on Windows gives paths like /c/Users/... — Python on Windows
# needs C:/Users/.... Translate if we detect the Git-Bash drive-letter shape.
if os.name == "nt" and len(path) > 2 and path[0] == "/" and path[2] == "/" and path[1].isalpha():
    path = path[1].upper() + ":" + path[2:]
try:
    with open(path) as f:
        m = json.load(f)
except Exception as e:
    print(f"[caddy:class_muted] load_failed path={path!r} err={e}", file=sys.stderr)
    sys.exit(1)
cls = os.environ["CLASS"]
now = datetime.now(timezone.utc)
def active(entry, label):
    if not entry or not isinstance(entry, dict): return False
    until = entry.get("muted_until")
    if not until: return False
    try:
        return datetime.fromisoformat(until.replace("Z","+00:00")) > now
    except Exception as e:
        print(f"[caddy:class_muted] parse_failed label={label} until={until!r} err={e}", file=sys.stderr)
        return False
sys.exit(0 if (active(m.get(cls), cls) or active(m.get("all"), "all")) else 1)
PYEOF
}

# ── ALWAYS-FIRE: routing discipline reminder ────────────────────────────────
# Per Will directive 2026-04-28 + [[feedback/Model routing discipline]].
# Fires every UserPromptSubmit so the AIgent consistently routes work to the
# cheapest model that can do the job, instead of doing builder work inline
# on Opus. The $161.57 session that caused the rule was inline-Opus drift.
class_muted routing || echo "[CADDY:routing] ROUTE — Reads/recon → Echo (haiku). Builds/writes/edits → Lyra (sonnet). Opus = strategy synthesis only. Default cheapest model that can do the job; spawn the right agent before doing it inline."

# ── CONFUSION PATTERN: surface /orient ─────────────────────────────────────
# When the prompt signals the user is lost or doesn't know where things live,
# surface /orient and [[concepts/MAP]] before anything else.
INPUT_LOWER=$(echo "$INPUT" | tr '[:upper:]' '[:lower:]')
if echo "$INPUT_LOWER" | grep -qE \
  'where (does|do|did|is|are|should) .*(live|go|sit|exist)|which (repo|folder|directory)|who (handles|owns|builds)|who.s in charge of|what.s the rule (for|about)|i don.t know where|i.m not sure where|i have no idea where|i.m lost|where do i start|how do i find'; then
  class_muted routing || echo "[CADDY:routing] /orient — When lost or unsure where things live or who owns what, run /orient or read [[concepts/MAP]] first. Single source of orientation for every agent."
fi

# ── COMMS STYLE: surface voice rules when about to post to Agent Ops ───────
# Per Will directive 2026-05-01 + [[feedback/Comms style - human not AI]].
# Fires when the prompt signals an outbound comms post, reply, or relay.
# Reminds the AIgent to match your team voice instead of bold-header AI walls.
if echo "$INPUT_LOWER" | grep -qE \
  '(post|send|chime in|reply|relay|drop|put|share|tell|message|note) .*(comms|agent ops|agent-a|agent-b|the channel|the team|agentops)|in comms|to comms|/comms|in agent ops'; then
  class_muted routing || echo "[CADDY:routing] STYLE — Comms voice = your team. Drop bold-header openers, em-dashes, jargon walls. Default short. One point per message. See [[feedback/Comms style - human not AI]]."
fi

# ── AI CODING VOCAB: surface dictionary when agent-architecture terms appear ─
# Per Will directive 2026-05-01 + [[reference/AI Coding Dictionary]].
# Fires on compound terms unambiguously in dictionary territory — avoids
# false-positives on casual uses of "agent" / "skill" / "context".
if echo "$INPUT_LOWER" | grep -qE \
  'context window|system prompt|attention (budget|degrad|relationship)|smart zone|knowledge cutoff|parametric knowledge|next-token|prefix cache|cache token|vibe cod|agents\.md|sycophancy|harness|sub-?agent|compact(ion|ing)|handoff artifact|grilling|tool call|permission mode|model provider|inference engine|stateless model|vocabulary of (ai|agent)'; then
  class_muted routing || echo "[CADDY:routing] DICT — Agent vocab in play. Plain-English definitions live at [[reference/AI Coding Dictionary]]. Don't load by default — reference specific terms as needed."
fi

# ── REMINDB MCP: surface vault query layer for known-topic recalls ─────────
# Per Will directive 2026-05-01 + [[concepts/remindb]] AUGMENT verdict.
# Vault is now queryable via MCP tools (MemoryTree / MemorySearch / MemoryFetch /
# MemoryDelta / MemoryHistory / MemoryWrite). Default to MCP for known-topic
# recalls — saves 94-98% over cold-reading individual markdown notes.
if echo "$INPUT_LOWER" | grep -qE \
  '(read|load|recall|find|search|query|look up|pull up|grab|fetch) .*(vault|memory|notes?|concepts?|feedback|doctrine|standing rules?)|memory query|vault query|what does .*(say|cover|state)|where .*(does|do|did) .*(live|sit|exist|cover)|recall|catch me up'; then
  class_muted memory || echo "[CADDY:memory] MEMDB — Vault is queryable via MCP remindb tools (MemorySearch, MemoryTree, MemoryFetch, MemoryDelta). Use instead of cold-reading individual notes for known-topic queries. See [[concepts/remindb]]."
fi

# ── CONTEXT-MODE: surface ctx_execute / ctx_fetch_and_index for heavy ops ──
# Per Will directive 2026-05-02 (STANDING RULE, not suggestion).
# Context-mode is installed via plugin marketplace. Heavy bash output goes into
# the AIgent's context window directly; ctx_execute runs in sandbox + returns only
# the printed summary. ctx_fetch_and_index for URLs returns 3KB preview + full
# content stays in sandbox (searchable via ctx_search). See [[feedback/Use ctx_execute for heavy ops]].
if echo "$INPUT_LOWER" | grep -qE \
  'defuddle parse|webfetch|cat .*\.(log|output|json|txt|md)|head -|tail -|grep -A|grep -B|find .* -exec|wc -l|jq |awk |sed |xargs|process .*(json|log|csv|output)|analyze .*(log|output|response|dump)|fetch .*(url|page|readme|docs)|read .*(log|json|csv|api)'; then
  class_muted context || echo "[CADDY:context] CTX — Heavy bash op detected. Route through ctx_execute (sandbox script) or ctx_fetch_and_index (URL → 3KB preview + indexed for ctx_search). Keeps raw output OUT of the AIgent's context window. STANDING RULE — see [[feedback/Use ctx_execute for heavy ops]]."
fi

# ── SOMATIC v0.4.1: 3 new class-tagged hints ────────────────────────────────
# Per [[concepts/Somatic v0.4.1 Wiring]] §4. Hints fire on concrete trigger phrases
# and surface the right organ for the moment.

# memory: digest / promote / candidate triggers
if echo "$INPUT_LOWER" | grep -qE \
  '/digest|review.*candidates?|stage.*memory|promote .*(candidate|memory|note)|memory candidates?|new rule:|from now on,?|remember that|rule:'; then
  class_muted memory || echo "[CADDY:memory] DIGEST — Memory candidates may be staged. Run /digest to surface promote/skip/supersede options. Memory-authoring phrases bypass max-1-per-session limit. See [[concepts/Somatic Layer]] §digest."
fi

# ── Somatic v0.4.2 + v0.5.3: auto-capture memory candidates ───────────────
# Runs AFTER the [CADDY:memory] DIGEST hint. Best-effort: failure must never
# block hint output above. Errors route to DAEMON_ERR_LOG, not to stdout.
# Script is called with the raw prompt on stdin.
#
# v0.5.3: memory-capture.sh now includes Tier 2 correction patterns, so we
# call it on ANY prompt that contains correction-y signals — not only on the
# narrow memory-authoring keyword set. The script itself filters precisely.
# Spec: [[concepts/Somatic v0.4.2 Memory Capture]], [[concepts/Somatic v0.5.1-v0.5.3 Polish]]
if [ -x "$ROOT/daemons/memory-capture.sh" ]; then
  echo "$INPUT" | AIGENT_ROOT="$ROOT" bash "$ROOT/daemons/memory-capture.sh" 2>>"$DAEMON_ERR_LOG" || true
fi

# context: capsule / compact / handoff triggers
if echo "$INPUT_LOWER" | grep -qE \
  'context (getting|is) long|before compact|preserve context|save context|structured handoff|resume prompt|task done|milestone shipped|/context-capsule|/capsule'; then
  class_muted context || echo "[CADDY:context] CAPSULE — Pressure or completion trigger detected. /context-capsule produces a resume-ready capsule (frontmatter status: active, optional parent_capsule_id). /open offers resume next session."
fi

# body: body-check / vital sign triggers
if echo "$INPUT_LOWER" | grep -qE \
  'how am i doing|body check|body state|vital signs|/body-check|pressure check|context pressure|token pressure|where are we'; then
  class_muted body || echo "[CADDY:body] BODY-CHECK — /body-check composes the five pressures (context/memory/decision/delegation/token) lazily from existing signals. No daemon. See [[concepts/Somatic Layer]] / system/15."
fi

# ── Phase 1: Taxonomy recall fallback ────────────────────────────────────────
# After the trigger-phrase system below, scan SKILL_LEDGER taxonomy for broader
# matches. If BOTH systems miss, surface a gap hint. See [[Caddy Skill Recall Integration]].
LEDGER="$ROOT/memory/SKILL_LEDGER.md"
CHAINS="$ROOT/memory/SKILL_CHAINS.md"

# Pass $INPUT and $INDEX via env vars — NOT via raw string interpolation inside
# the heredoc — so that prompts containing quotes or special chars can't break
# the Python code. Single-quoted 'PYEOF' prevents all shell expansion inside.
INPUT="$INPUT" INDEX="$INDEX" LEDGER="$LEDGER" CHAINS="$CHAINS" python3 <<'PYEOF' 2>/dev/null || exit 0
import os, sys, json, re

raw = os.environ.get("INPUT", "")
index_path = os.environ.get("INDEX", "")

try:
    payload = json.loads(raw) if raw.strip().startswith("{") else {"prompt": raw}
except Exception:
    payload = {"prompt": raw}

prompt = payload.get("prompt") or payload.get("user_prompt") or ""
if not prompt:
    sys.exit(0)

try:
    with open(index_path, "r", encoding="utf-8") as f:
        skills = json.load(f)
except Exception:
    sys.exit(0)

prompt_lower = prompt.lower()

scores = []
for skill in skills:
    name = skill.get("name","")
    triggers = [t.lower() for t in skill.get("triggers", [])]
    score = 0
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
    if score > 0:
        scores.append((score, name, skill.get("why",""), matched))

scores.sort(reverse=True)
top = [s for s in scores if s[0] >= 2][:2]

for score, name, why, matched in top:
    print(f"[CADDY] /{name} - {why}")

# ── Taxonomy fallback: if trigger-match found nothing, scan SKILL_LEDGER ──
if not top:
    ledger_path = os.environ.get("LEDGER", "")
    chains_path = os.environ.get("CHAINS", "")
    try:
        if ledger_path and os.path.isfile(ledger_path):
            with open(ledger_path, "r", encoding="utf-8") as lf:
                ledger_lines = lf.readlines()
            # Parse taxonomy entries: - `taxonomy.path` — description — skill
            import re as _re
            tax_pat = _re.compile(r'^- `([^`]+)` — (.+?) — (.+)$')
            stopwords = {'the','a','an','is','are','was','were','be','to','of','and','in','for','on','with','this','that','it','do','my','me','i','we','our','can','how','what','when','where','why','please','should','would','could'}
            words = [w for w in _re.findall(r'\w+', prompt_lower) if w not in stopwords and len(w) > 2]
            if words:
                tax_scores = []
                for line in ledger_lines:
                    m = tax_pat.match(line.strip())
                    if not m:
                        continue
                    path_str, desc, skill_ref = m.group(1), m.group(2).lower(), m.group(3)
                    path_tokens = path_str.replace('.', ' ').split()
                    desc_tokens = _re.findall(r'\w+', desc)
                    sc = 0
                    for w in words:
                        if w in path_tokens: sc += 2
                        if w in desc_tokens: sc += 1
                    if sc >= 3:
                        tax_scores.append((sc, path_str, desc.strip(), skill_ref.strip()))
                tax_scores.sort(reverse=True)
                if tax_scores:
                    best = tax_scores[0]
                    print(f"[CADDY:taxonomy] {best[3]} ({best[1]}) — {best[2]} — [LEDGER]")
                else:
                    # No match in triggers OR taxonomy — surface gap hint (once per session)
                    gap_flag = os.path.join(os.environ.get("ROOT", "/tmp"), "memory", ".caddy-gap-fired")
                    if not os.path.exists(gap_flag):
                        print("[CADDY:taxonomy] No skill match — the AIgent will run /skill-recall to log this gap")
                        try:
                            os.makedirs(os.path.dirname(gap_flag), exist_ok=True)
                            with open(gap_flag, "w") as gf:
                                gf.write("1")
                        except Exception:
                            pass
    except Exception:
        pass

    # Chain recall: check SKILL_CHAINS for prior successful sequences
    try:
        if chains_path and os.path.isfile(chains_path):
            with open(chains_path, "r", encoding="utf-8") as cf:
                chain_lines = cf.readlines()
            for cline in chain_lines:
                if '|' not in cline or cline.strip().startswith('|---') or cline.strip().startswith('| Date'):
                    continue
                parts = [p.strip() for p in cline.split('|')]
                if len(parts) >= 4:
                    obj = parts[2].lower() if len(parts) > 2 else ""
                    chain = parts[3] if len(parts) > 3 else ""
                    obj_tokens = _re.findall(r'\w+', obj)
                    overlap = sum(1 for w in words if w in obj_tokens)
                    if overlap >= 3 and chain:
                        print(f"[CADDY:chain] Prior chain for similar objective: {chain} (see SKILL_CHAINS)")
                        break
    except Exception:
        pass
PYEOF

# ── Skill Router (Phase 2) ────────────────────────────────────────────────────
# Scores all active SkillCards against the prompt; emits a [CADDY:skill] MATCH
# hint if top score >= 2. Best-effort: failure must never block hints above.
# Errors go to DAEMON_ERR_LOG. Spec: [[concepts/aigent-OS Refactor Spec]] Phase 2.
if [ -x "$ROOT/daemons/skill-router.sh" ]; then
  SKILL_HINT=$(echo "$INPUT" | AIGENT_ROOT="$ROOT" DAEMON_ERR_LOG="$DAEMON_ERR_LOG" bash "$ROOT/daemons/skill-router.sh" 2>>"$DAEMON_ERR_LOG")
  [ -n "$SKILL_HINT" ] && echo "$SKILL_HINT"
fi

exit 0
