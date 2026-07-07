#!/bin/bash
# memory-capture.sh — Somatic v0.4.2 input organ
# Reads prompt text from stdin, matches high-confidence memory-authoring phrases,
# appends staged candidates to memory/MEMORY_CANDIDATES.md.
#
# Called from caddy.sh AFTER [CADDY:memory] DIGEST hint emits.
# Best-effort: failure MUST NOT block caddy hints. Errors route to DAEMON_ERR_LOG.
#
# Spec: [[concepts/Somatic v0.4.2 Memory Capture]]
# Doctrine: [[feedback/Silent successes hide failures]] — no 2>/dev/null without recovery sink.

ROOT="${AIGENT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CANDIDATES="$ROOT/memory/MEMORY_CANDIDATES.md"
DAEMON_ERR_LOG="$ROOT/memory/.daemon-errors.log"
TIER2_OBS_LOG="$ROOT/memory/.tier2-observations.log"

INPUT=$(cat 2>/dev/null)
[ -z "$INPUT" ] && exit 0

# Pass vars via env — NOT string interpolation — so quotes/special chars in
# prompt can't break the Python heredoc. Single-quoted 'PYEOF' prevents all
# shell expansion inside.
INPUT="$INPUT" \
CANDIDATES="$CANDIDATES" \
DAEMON_ERR_LOG="$DAEMON_ERR_LOG" \
TIER2_OBS_LOG="$TIER2_OBS_LOG" \
python3 <<'PYEOF' 2>>"$DAEMON_ERR_LOG"
import os, re, sys
from datetime import datetime, timezone, timedelta

prompt = os.environ.get("INPUT", "")
candidates_path = os.environ.get("CANDIDATES", "")
err_log = os.environ.get("DAEMON_ERR_LOG", "")
tier2_obs_log = os.environ.get("TIER2_OBS_LOG", "")

# ── Git-Bash → Windows path translation ────────────────────────────────────
# Git-Bash on Windows gives /c/Users/... — Python on Windows needs C:/Users/...
def fix_path(path):
    if os.name == "nt" and len(path) > 2 and path[0] == "/" and path[2] == "/" and path[1].isalpha():
        return path[1].upper() + ":" + path[2:]
    return path

candidates_path = fix_path(candidates_path)
err_log = fix_path(err_log)
tier2_obs_log = fix_path(tier2_obs_log)

def log_err(msg):
    """Append error to daemon log before raising/returning."""
    try:
        with open(err_log, "a", encoding="utf-8") as f:
            ts = datetime.now(timezone.utc).isoformat()
            f.write(f"[memory-capture] {ts} {msg}\n")
    except Exception:
        pass  # err_log itself unavailable — last resort: stderr
    print(f"[memory-capture] {msg}", file=sys.stderr)

def log_tier2_obs(pattern_name, confidence, trigger_text, banked):
    """Append one observation line to .tier2-observations.log (best-effort)."""
    if not tier2_obs_log:
        return
    try:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        snippet = trigger_text.replace("\n", " ")[:80]
        banked_str = "yes" if banked else "no"
        line = f"{ts} | {pattern_name} | {confidence} | {snippet} | banked={banked_str}\n"
        with open(tier2_obs_log, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception as e:
        log_err(f"tier2_obs_write_failed err={e}")

# ── Excluded phrases — these are caddy invocations, not memory-authoring ───
EXCLUDED = re.compile(
    r"^\s*/digest"
    r"|review\s+candidates?"
    r"|stage\s+memory"
    r"|promote\s+(candidate|memory|note)",
    re.IGNORECASE
)
if EXCLUDED.search(prompt):
    sys.exit(0)

# ── Strip non-human input ─────────────────────────────────────────────────
# The prompt includes tool output, agent responses, code blocks, JSON, XML.
# These are NOT Will's words. Strip them before matching to avoid false positives.
import html
prompt = html.unescape(prompt)
# Remove XML/HTML tags and their content (tool results, system reminders)
prompt = re.sub(r"<[^>]+>.*?</[^>]+>", "", prompt, flags=re.DOTALL)
prompt = re.sub(r"<[^>]+/>", "", prompt)
# Remove fenced code blocks
prompt = re.sub(r"```[\s\S]*?```", "", prompt)
# Remove inline code
prompt = re.sub(r"`[^`]+`", "", prompt)
# Remove JSON-like fragments (agent output often has trailing "}")
prompt = re.sub(r"\{[^{}]*\}", "", prompt)
# Remove lines starting with | (markdown tables — usually agent output)
prompt = re.sub(r"^\|.*$", "", prompt, flags=re.MULTILINE)
# If nothing left after stripping, exit
if not prompt.strip():
    sys.exit(0)

# ── Trigger pattern table ───────────────────────────────────────────────────
# Two tiers:
#   Tier 1 (original): explicit memory-authoring phrases. High precision.
#   Tier 2 (v0.5.3 addition): correction patterns. Will's real feedback style.
#     These fire on correction-y signals WITHOUT requiring trigger keywords.
#     Calibrated to capture what was missed in S31d:
#       - "em-dashes signal AI writing — drop them"
#       - "code repos shouldn't live in OneDrive"
#       - "divide timeline estimates by 30-60x"
#     All are corrections, none used from-now-on / rule: / remember-that.
#
# Option C hybrid: Tier 1 keeps high precision; Tier 2 adds correction recall.
# False-positive guard: Tier 2 patterns require a negative assertion (X should NOT /
# X signals / X is wrong) or explicit correction verb — not just any imperative.
#
# Each entry: (regex, type, confidence, label)
# label used for Tier 2 observability log — must be unique per pattern.
# Tier 1 entries have label=None (not observed).
PATTERNS = [
    # ── Tier 1: explicit memory-authoring (original) ────────────────────────
    (re.compile(r"\bremember\s+that\s+(.+)", re.IGNORECASE), "preference", "high", None),
    (re.compile(r"\bremember\s+to\s+(.+)", re.IGNORECASE), "preference", "high", None),
    (re.compile(r"\bfrom\s+now\s+on,?\s+(.+)", re.IGNORECASE), "doctrine", "high", None),
    (re.compile(r"\bnew\s+rule:?\s*(.+)", re.IGNORECASE), "doctrine", "high", None),
    # rule: must be at start of phrase (^|\.|\n) AND followed by colon — avoids
    # false-positives on "what's the rule for X" or "the rule is broken"
    (re.compile(r"(?:^|[.\n])\s*rule:\s+(.+)", re.IGNORECASE), "doctrine", "high", None),
    (re.compile(r"\bwe\s+(?:decided|agreed)\s+(.+)", re.IGNORECASE), "decision", "medium", None),
    (re.compile(r"\bgoing\s+forward,?\s+(.+)", re.IGNORECASE), "doctrine", "high", None),

    # ── Tier 2: correction patterns (v0.5.3 addition) ───────────────────────
    # "X signals AI writing", "X is a dead AI tell", "X is an AI tell"
    (re.compile(r"(.+?)\s+(?:signal|signals|is|are)\s+(?:a\s+)?(?:dead\s+)?ai\s+(?:tell|writing|pattern|flag|marker)", re.IGNORECASE), "doctrine", "medium", "correction_ai_tell"),
    # "never use X", "don't use X", "stop using X", "avoid X"
    (re.compile(r"\b(?:never|don't|do not|stop|avoid)\s+(?:use|using|write|writing|add|adding|put|putting|include|including)\s+(.+)", re.IGNORECASE), "doctrine", "medium", "correction_never_use"),
    # "shouldn't live in X", "shouldn't be in X" — architecture placement rules
    (re.compile(r"(.+?)\s+shouldn't\s+(?:live|sit|go|be|exist)\s+(?:in|on|under|inside)\s+(.+)", re.IGNORECASE), "doctrine", "medium", "correction_placement"),
    # "divide X by N" / "multiply X by N" — calibration corrections
    (re.compile(r"\b(?:divide|multiply)\s+(.+?)\s+(?:by|times)\s+[\d\-x×]+", re.IGNORECASE), "doctrine", "medium", "correction_calibration"),
    # "X is wrong" / "that's wrong" / "no, it's" — explicit disagreement + correction
    # Must be followed by at least 5 chars of content to avoid bare "that's wrong" with no info
    (re.compile(r"(?:that's|that is|you're|you are|this is)\s+wrong[,.]?\s+(.{5,})", re.IGNORECASE), "doctrine", "medium", "correction_wrong"),
    # REMOVED: correction_actually — matched any "actually" + 10 chars, 100% false positive rate.
    # REMOVED: correction_drop — matched any "drop/cut/remove", same problem.
    # Real corrections from Will are short imperative sentences. Tier 1 patterns
    # ("from now on", "new rule", "remember that") catch those. If Will says
    # "drop em-dashes" it'll be caught by correction_never_use ("don't use em-dashes")
    # or he'll say "from now on, no em-dashes" which Tier 1 catches.
]

def suggested_destination(phrase_type, phrase_stem):
    """Rule-based destination default by type (spec §2)."""
    if phrase_type == "doctrine":
        return "concepts/Standing Rules - Operations.md"
    if phrase_type == "preference":
        # Slugify first 40 chars of stem for filename hint
        slug = re.sub(r"[^a-z0-9]+", "-", phrase_stem[:40].lower()).strip("-")
        return f"feedback/{slug}.md"
    if phrase_type == "decision":
        return "memory/DECISION_LOG.md"
    return "concepts/Standing Rules - Operations.md"

def normalize(text):
    """Lowercase + collapse whitespace for dedup comparison."""
    return re.sub(r"\s+", " ", text.lower().strip())

# ── Read current candidates file ───────────────────────────────────────────
try:
    with open(candidates_path, "r", encoding="utf-8") as f:
        content = f.read()
except Exception as e:
    log_err(f"read_failed path={candidates_path!r} err={e}")
    sys.exit(1)

# ── Count staged rows + extract existing phrases for dedup ─────────────────
# Row format: | date | "phrase" | type | confidence | dest | status | digested_on | note |
row_re = re.compile(
    r"^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*\"(.*?)\"\s*\|.*?\|\s*(staged|promoted|skipped|superseded)\s*\|",
    re.MULTILINE
)
staged_count = 0
recent_staged_phrases = []  # (normalized_phrase, captured_at)
now_utc = datetime.now(timezone.utc)
window_24h = now_utc - timedelta(hours=24)

for m in row_re.finditer(content):
    row_date_str = m.group(1)
    row_phrase = m.group(2)
    row_status = m.group(3)
    if row_status == "staged":
        staged_count += 1
        # Parse row_date as date-only; treat as UTC midnight for dedup window
        try:
            row_dt = datetime.strptime(row_date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            if row_dt >= window_24h:
                recent_staged_phrases.append(normalize(row_phrase))
        except Exception:
            pass

# ── Hard cap check (spec §3) ───────────────────────────────────────────────
if staged_count >= 50:
    print("[CADDY:memory] CAP — MEMORY_CANDIDATES backlog at 50, /digest before more candidates auto-stage")
    sys.exit(0)

# ── Match trigger patterns ─────────────────────────────────────────────────
today = now_utc.strftime("%Y-%m-%d")
rows_to_append = []

for pattern, ptype, confidence, label in PATTERNS:
    m = pattern.search(prompt)
    is_tier2 = label is not None

    if not m:
        # Tier 2 non-match: no observation needed (only log fires, not misses)
        continue

    phrase_stem = m.group(1).strip()
    # Truncate to 200 chars with ellipsis
    if len(phrase_stem) > 200:
        phrase_stem = phrase_stem[:197] + "..."
    # Reconstruct full source phrase from match
    source_phrase = m.group(0).strip()
    if len(source_phrase) > 200:
        source_phrase = source_phrase[:197] + "..."
    norm = normalize(source_phrase)

    # Dedupe: same phrase still staged within 24h → skip
    if norm in recent_staged_phrases:
        if is_tier2:
            log_tier2_obs(label, confidence, source_phrase, banked=False)
        continue

    # Cap re-check per row (in case multiple matches in one prompt)
    if staged_count + len(rows_to_append) >= 50:
        if is_tier2:
            log_tier2_obs(label, confidence, source_phrase, banked=False)
        print("[CADDY:memory] CAP — MEMORY_CANDIDATES backlog at 50, /digest before more candidates auto-stage")
        break

    dest = suggested_destination(ptype, phrase_stem)
    # Escape any pipes in source phrase (would break markdown table)
    source_escaped = source_phrase.replace("|", "&#124;")
    row = f'| {today} | "{source_escaped}" | {ptype} | {confidence} | {dest} | staged | null | Auto-captured from prompt |'
    rows_to_append.append((norm, row))

    # Tier 2 observability: log every fire as banked=yes
    if is_tier2:
        log_tier2_obs(label, confidence, source_phrase, banked=True)

if not rows_to_append:
    sys.exit(0)

# ── Append rows under ## Candidates section ────────────────────────────────
CANDIDATES_HEADER = "## Candidates"
if CANDIDATES_HEADER not in content:
    log_err(f"candidates_header_missing path={candidates_path!r} — cannot append")
    sys.exit(1)

# Add table header if no rows exist yet (file still has placeholder text)
if "| staged |" not in content and "| promoted |" not in content:
    # Insert table header row after ## Candidates and its trailing blank line
    table_header = "\n| Date | Source Phrase | Type | Confidence | Suggested Destination | Status | Digested On | Note |\n|------|--------------|------|------------|----------------------|--------|-------------|------|\n"
    insert_point = content.index(CANDIDATES_HEADER) + len(CANDIDATES_HEADER)
    # Skip past any existing blank line / placeholder text up to end of section
    # Simple approach: find end of file, strip trailing empty-placeholder line
    content = content.replace(
        "\n\n(empty at ship — `/digest` populates and updates this section)",
        table_header
    )
    # If placeholder wasn't there, just append header after section heading
    if table_header.strip() not in content:
        idx = content.index(CANDIDATES_HEADER) + len(CANDIDATES_HEADER)
        content = content[:idx] + table_header + content[idx:]

new_rows = "\n".join(r for _, r in rows_to_append)
content = content.rstrip("\n") + "\n" + new_rows + "\n"

try:
    with open(candidates_path, "w", encoding="utf-8") as f:
        f.write(content)
except Exception as e:
    log_err(f"write_failed path={candidates_path!r} err={e}")
    sys.exit(1)

sys.exit(0)
PYEOF

# Best-effort: capture script exit code must NOT propagate to caddy.sh.
# Errors already routed to DAEMON_ERR_LOG above.
exit 0
