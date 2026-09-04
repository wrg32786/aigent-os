#!/bin/bash
# Hook: Stop — summarize auto-captured session activity
# Reads today's Session Captures, appends a brief footer with stats

VAULT="${AIGENT_ROOT:-.}"
TODAY=$(date +%Y-%m-%d)
mkdir -p "$VAULT/vault/daily"
DAILY="$VAULT/vault/daily/$TODAY.md"
TIME=$(date +%H:%M:%S)
# The error log lives in the seat's memory root, resolved by the one resolver
# every hook uses. Before this the hook created a stray memory/ tree at the
# root of every stock install. A broken declaration is reported to stderr and
# the hook keeps going without a log path.
. "$VAULT/daemons/memory-root.sh"
if MEMORY_ROOT="$(aigent_memory_root "${AIGENT_STATE_HOME_DIR:-$VAULT}" 2>&1)"; then
  ERRLOG="$MEMORY_ROOT/.daemon-errors.log"
  mkdir -p "$(dirname "$ERRLOG")"
else
  printf '%s\n' "$MEMORY_ROOT" >&2
  ERRLOG=/dev/null
fi

# Exit if no daily note or no captures
[ ! -f "$DAILY" ] && exit 0
grep -q "## Session Captures" "$DAILY" || exit 0

# Count captures and extract unique files/tools.
# $DAILY and $TIME are passed as node argv (process.argv[1]/[2]), never pasted
# into the JS source string below -- a $DAILY containing an apostrophe (any
# install path with one, e.g. "O'Brien's Projects") used to break out of the
# '$DAILY' single-quote literal, and the swallowed stderr hid the resulting
# syntax error completely (Codex finding #40). argv needs no escaping because
# it never touches source text -- same pattern hooks/log-token-usage.sh
# already uses for its own file/date/time arguments.
#
# node.exe on Git-Bash/Windows is a native (non-MSYS) executable, so bash's
# own MSYS runtime auto-converts a POSIX-shaped argv path to a Windows path
# before exec -- and that conversion mishandles an apostrophe in the path,
# producing a garbled path (reproduced independently of this fix: a bare
# apostrophe path passed to `node -e ... "$path"` under Git Bash resolves to
# the wrong location and node throws ENOENT). Pre-converting via cygpath -w
# ourselves sidesteps it -- an already-Windows-style path is passed through
# unmangled. No-op on macOS/Linux, where cygpath doesn't exist and node
# shares bash's own path convention already.
DAILY_FOR_NODE="$DAILY"
if command -v cygpath >/dev/null 2>&1; then
  DAILY_FOR_NODE="$(cygpath -w "$DAILY")"
fi

unsafeRawSessionCaptureSummary() {
  local daily_path="$1"
  local summary_time="$2"
  local reason="${3:-}"
  [ -n "$reason" ] || {
    printf 'unsafeRawSessionCaptureSummary requires a reason\n' >&2
    return 64
  }

  STATS=$(node -e "
const fs = require('fs');
const dailyPath = process.argv[1];
const time = process.argv[2];
const content = fs.readFileSync(dailyPath, 'utf8');
const LINE_BREAKING = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function singleLine(value) {
  return String(value ?? '').replace(LINE_BREAKING, ' ').replace(/\s+/g, ' ').trim();
}

function bounded(value, limit) {
  const text = singleLine(value);
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '…[truncated ' + (text.length - limit) + ' chars]';
}

function inert(value, limit) {
  return JSON.stringify(bounded(value, limit));
}

function jsonStringAt(text, start) {
  if (text.charCodeAt(start) !== 34) return null;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (escaped) {
      escaped = false;
    } else if (code === 92) {
      escaped = true;
    } else if (code === 34) {
      try {
        const value = JSON.parse(text.slice(start, index + 1));
        return typeof value === 'string' ? { value, end: index + 1 } : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function captureRow(line) {
  const firstSeparator = line.indexOf(' | ');
  if (firstSeparator < 0) return null;
  const toolCell = jsonStringAt(line, firstSeparator + 3);
  if (toolCell && line.slice(toolCell.end, toolCell.end + 3) === ' | ') {
    const descriptionCell = jsonStringAt(line, toolCell.end + 3);
    if (descriptionCell && descriptionCell.end === line.length) {
      return {
        tool: singleLine(toolCell.value),
        description: singleLine(descriptionCell.value),
      };
    }
  }

  // Backward compatibility for captures written before fields were JSON-quoted.
  const parts = line.split(' | ');
  if (parts.length < 3) return null;
  return {
    tool: singleLine(parts[1]),
    description: singleLine(parts.slice(2).join(' | ')),
  };
}

const captureSection = content.split('## Session Captures')[1] || '';
// Stop at next ## section if any
const captures = captureSection.split(/\n## /)[0];
const rows = captures.trim().split('\n')
  .filter(line => line.startsWith('- '))
  .map(captureRow)
  .filter(Boolean);

if (rows.length === 0) { process.exit(0); }

const tools = new Set();
const files = new Set();
for (const row of rows) {
  tools.add(row.tool);
  // Extract file paths (anything with / or .ext).
  if (row.description.match(/\.\w+/) && !row.description.startsWith('git ')) {
    files.add(row.description.split(' ')[0]);
  }
}

const allTools = [...tools];
const visibleTools = allTools.slice(0, 12).map(tool => inert(tool, 80));
const omittedTools = allTools.length - visibleTools.length;
const toolList = visibleTools.join(', ')
  + (omittedTools > 0 ? ', …[' + omittedTools + ' more tools]' : '');
const fileCount = files.size;
const fileSample = [...files].slice(0, 3).map(file => inert(file, 160)).join(', ');
const summary = rows.length + ' actions (' + toolList + ')';
const fileInfo = fileCount > 0 ? ' | ' + fileCount + ' files touched' + (fileSample ? ': ' + fileSample : '') : '';
console.log('> [!info] Session ' + inert(time, 32) + ' — ' + summary + fileInfo);
" "$daily_path" "$summary_time" 2>>"$ERRLOG")
}

unsafeRawSessionCaptureSummary \
  "$DAILY_FOR_NODE" \
  "$TIME" \
  "the summary reads a multiline daily capture section before rendering each field through a quoted bound"

[ -z "$STATS" ] && exit 0

# Append footer after captures
echo "$STATS" >> "$DAILY"
