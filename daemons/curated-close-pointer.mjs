#!/usr/bin/env node
// curated-close-pointer.mjs — compatibility pointer writer, used by a manual
// close flow. Resume selection no longer reads this pointer at all (resume-verb
// selects the newest valid capsule by created_at) — this stamp is an
// audit/orientation hint only.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { memRoot, seatOf } from './lifecycle-common.mjs';

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

const bodyPath = path.join(memory, 'BODY_STATE.json');
let body;
try { body = JSON.parse(readFileSync(bodyPath, 'utf8')); }
catch (error) { fail(`BODY_STATE.json unreadable: ${error?.message || error}`); }
if (!body?.state) fail('BODY_STATE.json has no .state — pointer not stamped');
body.state.last_capsule = pointer;
writeFileSync(bodyPath, JSON.stringify(body, null, 2));

console.log(`[curated-close-pointer] STAMPED ${seat}: ${id}`);
