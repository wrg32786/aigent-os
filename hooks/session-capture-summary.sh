#!/bin/bash
# Hook: Stop — summarize auto-captured session activity
# Reads today's Session Captures, appends a brief footer with stats

VAULT="${AIGENT_ROOT:-.}"
TODAY=$(date +%Y-%m-%d)
mkdir -p "$VAULT/vault/daily"
DAILY="$VAULT/vault/daily/$TODAY.md"
TIME=$(date +%H:%M:%S)

# Exit if no daily note or no captures
[ ! -f "$DAILY" ] && exit 0
grep -q "## Session Captures" "$DAILY" || exit 0

# Count captures and extract unique files/tools
STATS=$(node -e "
const fs = require('fs');
const content = fs.readFileSync('$DAILY', 'utf8');
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
console.log('> [!info] Session $TIME — ' + summary + fileInfo);
" 2>/dev/null)

[ -z "$STATS" ] && exit 0

# Append footer after captures
echo "$STATS" >> "$DAILY"
