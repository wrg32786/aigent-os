// injection-scan.mjs -- reads threat-patterns.json and reports whether a piece
// of text is trying to instruct the reader rather than inform it.
//
// THE FAILURE THIS EXISTS FOR: memory is the one surface where untrusted text
// gets promoted to trusted text. A web page, a tool result, a pasted block, a
// message from another agent -- any of it can reach a memory staging queue, and
// once a line is promoted into the vault it stops being quoted content and
// starts being injected as the reader's own standing context, every session,
// with no provenance attached. Prompt injection does not need to survive one
// turn if it can survive into memory.
//
// A hit is not a verdict of malice and never deletes anything. It marks the row
// so it cannot be promoted without a human looking at it. That direction is
// chosen deliberately: a false positive costs one glance, a false negative costs
// a permanent instruction nobody wrote.
//
// Scope note, stated because a scanner is easy to over-trust: this is a
// pattern-matched net over known shapes. It will not catch a novel phrasing, and
// it is not a substitute for treating tool output as untrusted at read time.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PATTERNS_FILE = path.join(MODULE_DIR, 'threat-patterns.json');

let cache = null;

export function loadPatterns(file = PATTERNS_FILE) {
  if (cache && cache.file === file) return cache.patterns;
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const patterns = (raw.patterns || []).map((entry) => ({
    id: String(entry.id),
    description: String(entry.description || ''),
    // 'i' only. The table is documented as anchor-free precisely so that no
    // reader needs multiline semantics to agree with any other reader.
    regex: new RegExp(entry.pattern, 'i'),
  }));
  cache = { file, patterns };
  return patterns;
}

// Returns every matching pattern, not the first. Which shapes fired is the
// useful signal for a reviewer; "something fired" is not.
export function scanText(text, options = {}) {
  const source = String(text ?? '');
  if (!source.trim()) return [];
  const hits = [];
  for (const pattern of loadPatterns(options.file)) {
    const match = source.match(pattern.regex);
    if (match) hits.push({ id: pattern.id, match: match[0].slice(0, 120) });
  }
  return hits;
}

export function isClean(text, options = {}) {
  return scanText(text, options).length === 0;
}

// The marker a blocked item carries. Machine-greppable prefix first, because
// the thing most likely to read it back is another check.
export function blockedMarker(hits) {
  const ids = (hits || []).map((hit) => hit.id).join(',');
  return `[BLOCKED: memory-injection ${ids}]`;
}

const direct = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (direct) {
  const fileIndex = process.argv.indexOf('--file');
  let input = '';
  if (fileIndex >= 0) {
    input = readFileSync(process.argv[fileIndex + 1], 'utf8');
  } else {
    try { input = readFileSync(0, 'utf8'); } catch { input = ''; }
  }
  const hits = scanText(input);
  if (hits.length) {
    process.stdout.write(
      `MEMORY_INJECTION HIT patterns=${hits.length} ids=${hits.map((h) => h.id).join(',')}\n`
      + `${blockedMarker(hits)}\n`,
    );
    process.exit(2);
  }
  process.stdout.write('MEMORY_INJECTION CLEAN patterns=0\n');
  process.exit(0);
}
