// transcript-path-config-dir.test.mjs -- the transcript lives where Claude
// Code puts it, and Claude Code honors CLAUDE_CONFIG_DIR.
//
// A seat that isolates its Claude configuration (CLAUDE_CONFIG_DIR set to a
// directory of its own) writes its transcripts under
// <CLAUDE_CONFIG_DIR>/projects/<slug>/<session>.jsonl. The shared resolver
// built <home>/.claude/projects/... regardless, so the checkpoint check
// reported checkpoint-transcript-missing on every automatic clear and the
// cycle held until a human cleared by hand. The fix is one shared resolver
// honoring the variable, default unchanged when it is unset.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  transcriptPathFor, claudeConfigDir, evaluateCheckpointFreshness, slugifyCwd,
} from '../auto-clear-transport.mjs';

const SESSION_ID = '7acd0927-8e9b-4b45-abee-1cf9e77dc4d3';

function writeText(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}

function writeCapsule(memRoot, id) {
  const target = path.join(memRoot, 'capsules', `${id}.md`);
  const fm = { id, objective: 'fixture', status: 'active', waiting_on: 'x', next_valid_action: 'y', created_at: '2026-09-04T00:00:00.000Z' };
  const body = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  return writeText(target, `---\n${body}\n---\n\n# fixture\n`);
}

// A seat with an isolated Claude configuration: the transcript exists ONLY
// under the config dir, exactly as the failing seat's disk looked.
function makeSeat({ isolated }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-cfg-'));
  const homeDir = path.join(base, 'home');
  const cwd = path.join(base, 'work', 'seat');
  const configDir = isolated ? path.join(base, 'ClaudeSeats', 'seat') : path.join(homeDir, '.claude');
  const env = isolated ? { CLAUDE_CONFIG_DIR: configDir } : {};
  const transcriptPath = path.join(configDir, 'projects', slugifyCwd(cwd), `${SESSION_ID}.jsonl`);
  const transcript = '0123456789';
  writeText(transcriptPath, transcript);
  const memRoot = path.join(base, 'memory');
  const capsulePath = writeCapsule(memRoot, '2026-09-04-fixture');
  // The Stop-hook record the checkpoint compares against.
  writeText(path.join(memRoot, 'runtime', 'stop-writer', `${SESSION_ID}.json`), JSON.stringify({
    session_id: SESSION_ID, offset: Buffer.byteLength(transcript), capsule_path: capsulePath, transcript_path: transcriptPath,
  }));
  return { base, homeDir, cwd, configDir, env, transcriptPath, memRoot };
}

test('claudeConfigDir: CLAUDE_CONFIG_DIR when set, <home>/.claude when not', () => {
  assert.equal(claudeConfigDir({ env: {}, homeDir: '/h' }), path.join('/h', '.claude'));
  assert.equal(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '' }, homeDir: '/h' }), path.join('/h', '.claude'), 'an empty value is unset');
  assert.equal(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '   ' }, homeDir: '/h' }), path.join('/h', '.claude'), 'a blank value is unset');
  assert.equal(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '/seats/one' }, homeDir: '/h' }), '/seats/one');
});

test('transcriptPathFor: the isolated seat resolves under its config dir; the default seat is unchanged', () => {
  const isolated = makeSeat({ isolated: true });
  const stock = makeSeat({ isolated: false });
  try {
    assert.equal(
      transcriptPathFor({ cwd: isolated.cwd, sessionId: SESSION_ID, homeDir: isolated.homeDir, env: isolated.env }),
      isolated.transcriptPath,
      'the resolver must build the path Claude Code actually wrote',
    );
    assert.equal(
      transcriptPathFor({ cwd: stock.cwd, sessionId: SESSION_ID, homeDir: stock.homeDir, env: stock.env }),
      stock.transcriptPath,
      'with the variable unset the path is <home>/.claude/projects/..., as before',
    );
    assert.equal(
      transcriptPathFor({ cwd: stock.cwd, sessionId: SESSION_ID, homeDir: stock.homeDir }),
      stock.transcriptPath,
      'callers that pass no env keep the default',
    );
  } finally {
    fs.rmSync(isolated.base, { recursive: true, force: true });
    fs.rmSync(stock.base, { recursive: true, force: true });
  }
});

test('checkpoint: the isolated seat is judged against its real transcript, not a phantom under the home', () => {
  const isolated = makeSeat({ isolated: true });
  const stock = makeSeat({ isolated: false });
  try {
    const judge = (seat) => evaluateCheckpointFreshness({
      memRoot: seat.memRoot, sessionId: SESSION_ID, cwd: seat.cwd, homeDir: seat.homeDir, env: seat.env, ackFresh: true,
    });
    const control = judge(stock);
    assert.equal(control.ok, true, `the default seat must pass (control): ${JSON.stringify(control)}`);
    const verdict = judge(isolated);
    assert.notEqual(verdict.code, 'checkpoint-transcript-missing',
      `the isolated seat's transcript exists at ${isolated.transcriptPath} and must be found there`);
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
    assert.equal(verdict.transcript?.path, isolated.transcriptPath, 'the checkpoint reports the path it actually judged');
  } finally {
    fs.rmSync(isolated.base, { recursive: true, force: true });
    fs.rmSync(stock.base, { recursive: true, force: true });
  }
});

// ── structural: no core reader builds a Claude config path by hand ──────────
//
// Every reader of Claude's project logs or config artifacts goes through
// claudeConfigDir (JS) or the CLAUDE_CONFIG_DIR-or-~/.claude idiom (shell,
// Python). A hand-built "<home>/.claude/projects" is how this seat's
// transcript became a phantom.

import { readdirSync, existsSync } from 'node:fs';

function coreFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'tests', 'transport-deps', 'templates'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|cjs|js|sh|py)$/.test(entry.name)) out.push(full);
    }
  };
  for (const top of ['daemons', 'hooks', 'scripts']) if (existsSync(path.join(REPO, top))) walk(path.join(REPO, top));
  return out;
}
const REPO = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');

test('structural: no core reader builds "<home>/.claude/projects" or the statusline delegate path by hand', () => {
  const offenders = [];
  for (const file of coreFiles()) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    if (rel === 'daemons/auto-clear-transport.mjs') continue; // claudeConfigDir lives here
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (/^\s*(#|\/\/)/.test(line)) return; // comments describe, they do not resolve
      const handBuilt = /\.claude['"]?\s*[,/]\s*['"]?projects/.test(line)
        || /\$HOME\/\.claude\/projects/.test(line)
        || /~\/\.claude\/projects/.test(line)
        || /['"]\.claude['"]\s*,\s*['"]statusline-command\.sh['"]/.test(line)
        || /\$HOME\/\.claude\/statusline-command\.sh/.test(line);
      if (handBuilt && !/CLAUDE_CONFIG_DIR/.test(line)) offenders.push(`${rel}:${index + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(offenders, [], `readers must honor CLAUDE_CONFIG_DIR:\n${offenders.join('\n')}`);
});

test('checkpoint: a transcript that truly is missing is still reported as missing, under the config dir path', () => {
  const isolated = makeSeat({ isolated: true });
  try {
    fs.rmSync(isolated.transcriptPath);
    const verdict = evaluateCheckpointFreshness({
      memRoot: isolated.memRoot, sessionId: SESSION_ID, cwd: isolated.cwd, homeDir: isolated.homeDir, env: isolated.env, ackFresh: true,
    });
    assert.equal(verdict.code, 'checkpoint-transcript-missing');
    assert.equal(verdict.detail?.path, isolated.transcriptPath, 'the hold names the config-dir path, so an operator can see where it looked');
  } finally {
    fs.rmSync(isolated.base, { recursive: true, force: true });
  }
});
