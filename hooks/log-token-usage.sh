#!/bin/bash
# Hook: Stop — log session token usage to vault
# Parses current session JSONL, computes tokens + estimated cost, appends to usage log

VAULT="${AIGENT_ROOT:-.}"
mkdir -p "$VAULT/vault/memory"
USAGE_LOG="$VAULT/vault/memory/usage_log.md"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$HOME/.claude/projects}"
TODAY=$(date +%Y-%m-%d)
TIME=$(date +%H:%M:%S)

# Prefer session-anchored file via CLAUDE_SESSION_ID if available; otherwise fall back to most-recently-modified JSONL.
# Limitation: mtime sort may pick up a different session's file if multiple sessions share PROJECT_DIR.
if [ -n "${CLAUDE_SESSION_ID:-}" ]; then
  LATEST=$(ls "$PROJECT_DIR"/*.jsonl 2>/dev/null | grep -F "$CLAUDE_SESSION_ID" | head -1)
fi
[ -z "${LATEST:-}" ] && LATEST=$(ls -t "$PROJECT_DIR"/*.jsonl 2>/dev/null | head -1)
[ -z "$LATEST" ] && exit 0

# Parse JSONL and compute usage + cost in one node call
ENTRY=$(node -e "
const fs = require('fs');
const lines = fs.readFileSync(process.argv[1], 'utf8').split('\n').filter(Boolean);

// Model-aware pricing (per million tokens, USD). Rates as of 2026-05.
// Canonical source: https://www.anthropic.com/pricing
const PRICING = {
  'claude-opus-4-7':   { input: 15,   output: 75,  cache_read: 1.50,  cache_create: 18.75 },
  'claude-opus-4-6':   { input: 15,   output: 75,  cache_read: 1.50,  cache_create: 18.75 },
  'claude-sonnet-4-6': { input: 3,    output: 15,  cache_read: 0.30,  cache_create: 3.75  },
  'claude-haiku-4-5':  { input: 0.80, output: 4,   cache_read: 0.08,  cache_create: 1.00  },
};
const DEFAULT_PRICING = PRICING['claude-opus-4-7']; // conservative fallback

let totalCost = 0;
let input = 0, output = 0, cacheCreate = 0, cacheRead = 0, calls = 0;
let firstTs = null, lastTs = null;
const modelsSeen = new Set();

for (const line of lines) {
  try {
    const j = JSON.parse(line);
    if (j.type === 'assistant' && j.message?.usage) {
      const u = j.message.usage;
      const model = j.message?.model || '';
      modelsSeen.add(model);
      const rates = PRICING[model] || DEFAULT_PRICING;

      const inp = (u.input_tokens || 0);
      const out = (u.output_tokens || 0);
      const cc  = (u.cache_creation_input_tokens || 0);
      const cr  = (u.cache_read_input_tokens || 0);

      input += inp;
      output += out;
      cacheCreate += cc;
      cacheRead += cr;
      calls++;

      totalCost += (inp / 1e6) * rates.input
                 + (out / 1e6) * rates.output
                 + (cc  / 1e6) * rates.cache_create
                 + (cr  / 1e6) * rates.cache_read;
    }
    if (j.type === 'assistant') {
      const ts = j.timestamp || j.message?.timestamp;
      if (ts) {
        const d = new Date(ts).getTime();
        if (!isNaN(d)) {
          if (!firstTs) firstTs = d;
          lastTs = d;
        }
      }
    }
  } catch(e) {}
}

if (input === 0 && output === 0) process.exit(0);

const durationMin = (firstTs && lastTs) ? Math.round((lastTs - firstTs) / 60000) : 0;
const dur = durationMin > 0 ? durationMin + 'min' : '<1min';

const fmt = (n) => n >= 1000 ? Math.round(n/1000) + 'K' : String(n);

console.log('| ' + process.argv[2] + ' ' + process.argv[3] + ' | ' + dur + ' | ' + fmt(input) + ' | ' + fmt(output) + ' | ' + fmt(cacheRead) + ' | ' + calls + ' | \$' + totalCost.toFixed(2) + ' |');
" "$LATEST" "$TODAY" "$TIME" 2>/dev/null)

[ -z "$ENTRY" ] && exit 0

# Create usage log if it doesn't exist
if [ ! -f "$USAGE_LOG" ]; then
  cat > "$USAGE_LOG" << 'EOF'
---
title: Token Usage Log
tags:
  - memory
  - operations
aliases:
  - usage log
---

# Token Usage Log

Running log of per-session token spend for [[aigent-OS]]. Updated automatically on session end.

| Date | Duration | Input | Output | Cache Read | Calls | Est. Cost |
|------|----------|-------|--------|------------|-------|-----------|
EOF
fi

echo "$ENTRY" >> "$USAGE_LOG"
