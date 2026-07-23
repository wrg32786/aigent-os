#!/bin/bash
# Hook: Stop — summarize auto-captured session activity
# Reads today's Session Captures, appends a brief footer with stats

VAULT="${AIGENT_ROOT:-.}"
TODAY=$(date +%Y-%m-%d)
mkdir -p "$VAULT/vault/daily"
DAILY="$VAULT/vault/daily/$TODAY.md"
TIME=$(date +%H:%M:%S)
ERRLOG="$VAULT/memory/.daemon-errors.log"
mkdir -p "$(dirname "$ERRLOG")"

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
STATS=$(node -e "
const fs = require('fs');
const dailyPath = process.argv[1];
const time = process.argv[2];
const content = fs.readFileSync(dailyPath, 'utf8');
const captureSection = content.split('## Session Captures')[1] || '';
// Stop at next ## section if any
const captures = captureSection.split(/\n## /)[0];
const lines = captures.trim().split('\n').filter(l => l.startsWith('- '));

if (lines.length === 0) { process.exit(0); }

const tools = new Set();
const files = new Set();
for (const line of lines) {
  const parts = line.split(' | ');
  if (parts.length >= 3) {
    tools.add(parts[1].trim());
    const desc = parts.slice(2).join(' | ').trim();
    // Extract file paths (anything with / or .ext)
    if (desc.match(/\.\w+/) && !desc.startsWith('git ')) {
      files.add(desc.split(' ')[0]);
    }
  }
}

const toolList = [...tools].join(', ');
const fileCount = files.size;
const fileSample = [...files].slice(0, 3).join(', ');
const summary = lines.length + ' actions (' + toolList + ')';
const fileInfo = fileCount > 0 ? ' | ' + fileCount + ' files touched' + (fileSample ? ': ' + fileSample : '') : '';
console.log('> [!info] Session ' + time + ' — ' + summary + fileInfo);
" "$DAILY_FOR_NODE" "$TIME" 2>>"$ERRLOG")

[ -z "$STATS" ] && exit 0

# Append footer after captures
echo "$STATS" >> "$DAILY"
