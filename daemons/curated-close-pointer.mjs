#!/usr/bin/env node
// curated-close-pointer.mjs — compatibility pointer writer, used by a manual
// close flow. Resume selection no longer reads this pointer at all (resume-verb
// selects the newest valid capsule by created_at) — this stamp is an
// audit/orientation hint only.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { memRoot, seatOf } from './lifecycle-common.mjs';

const require = createRequire(import.meta.url);
const { atomicUpdateJson } = require('./memory-hygiene/atomic-state.cjs');

function fail(message) {
  console.error(`[curated-close-pointer] REFUSED: ${message}`);
  process.exit(1);
}

const capsuleArg = process.argv[2];
if (!capsuleArg || capsuleArg.startsWith('--')) {
  fail('usage: curated-close-pointer.mjs <capsule-path>');
}

const root = String(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const seat = seatOf(root);
const memory = memRoot(root);
const capsulePath = path.resolve(root, capsuleArg);
if (!existsSync(capsulePath)) fail(`capsule not found: ${capsulePath}`);

const doc = readFileSync(capsulePath, 'utf8');
const frontmatter = doc.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1] || '';
const field = (key) => {
  const raw = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))?.[1]?.trim() || '';
  return raw.replace(/^['"]|['"]$/g, '');
};
const id = field('id') || path.basename(capsulePath, '.md');
const pointer = {
  id,
  path: path.relative(root, capsulePath).replace(/\\/g, '/'),
  objective: (field('objective') || '(curated close)').slice(0, 300),
  status: field('status') || 'active',
  created_at: field('created_at') || new Date().toISOString(),
  trigger: 'curated-close',
};

// The stop-hook writes this same pointer whenever a session ends. Two writers on
// one field is the whole reason this goes through the lock: without it, whichever
// of the two read first can commit last and erase the other's stamp, leaving a
// pointer that is valid, well-formed, and one capsule out of date.
const bodyPath = path.join(memory, 'BODY_STATE.json');
let missingState = false;
try {
  atomicUpdateJson(bodyPath, (body) => {
    if (!body?.state) { missingState = true; return null; }
    body.state.last_capsule = pointer;
    return body;
  });
} catch (error) {
  fail(`BODY_STATE.json not stamped: ${error?.message || error}`);
}
if (missingState) fail('BODY_STATE.json has no .state — pointer not stamped');

console.log(`[curated-close-pointer] STAMPED ${seat}: ${id}`);
