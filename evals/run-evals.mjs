#!/usr/bin/env node
// Executes the corpora in evals/. Until this file existed, they were JSON with
// expected_* fields that nothing read — files shaped like evidence, proving
// nothing. A verification that cannot fail is not evidence.
//
// THREE OUTCOMES, NOT TWO. pass / fail / unrunnable. The third one is the point:
// a case whose preconditions are absent has NOT passed, and reporting it as a
// skip is how an inert corpus looks healthy for months. Unrunnable is fatal
// unless the case declares `requires`, which marks a KNOWN, NAMED gap.
//
// DRIVES THE REAL SOURCE. skill-recall pipes prompts through daemons/caddy.sh as
// the hook does; capsule-resume calls newestValidCapsule() from
// daemons/lifecycle-common.mjs against a temp vault. Neither re-implements the
// logic it checks — a mirror stays green when the daemon regresses.
//
// Run: node evals/run-evals.mjs [--json]

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EVALS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(EVALS, '..');
const JSON_OUT = process.argv.includes('--json');

const results = [];
const record = (suite, id, status, detail) => results.push({ suite, id, status, detail });

function loadCorpus(name) {
  try { return JSON.parse(readFileSync(path.join(EVALS, name), 'utf8')); }
  catch (e) { return { __error: e?.message || String(e) }; }
}

// ── Suite 1: skill recall ─────────────────────────────────────────────────────
// Routes a prompt through the real caddy hook and asserts which skill it named.
// `must_not_suggest` is as load-bearing as `expected_skill`: a router that fires
// on everything has perfect recall and is useless.

function runSkillRecall() {
  const cases = loadCorpus('skill-recall-tests.json');
  if (cases.__error) { record('skill-recall', '-', 'unrunnable', `corpus unreadable: ${cases.__error}`); return; }

  let index;
  try { index = JSON.parse(readFileSync(path.join(ROOT, '.claude', 'skill-index.json'), 'utf8')); }
  catch (e) { record('skill-recall', '-', 'unrunnable', `no skill-index.json: ${e?.message}`); return; }
  const known = new Set(index.map((s) => s.name));

  for (const c of cases) {
    // A case naming a skill this install does not have cannot be evaluated. It is
    // NOT a routing failure and must not be scored as one — the original corpus
    // referenced four skills absent from this repo, which is how it stayed
    // plausible while being unrunnable.
    if (c.expected_skill && !known.has(c.expected_skill)) {
      record('skill-recall', c.id, 'unrunnable', `expected_skill "${c.expected_skill}" not in skill-index (${known.size} skills)`);
      continue;
    }
    // HARNESS ISOLATION, not cheating. caddy suppresses its no-match line after
    // the first miss per session via .aigent/cache/caddy-gap-<session_id>, and a
    // session-less invocation keys that flag on the literal "unknown" — so every
    // caller without a session id shares ONE flag and the second eval run in a
    // job sees different behaviour from the first. Clearing the flag per case is
    // what makes routing deterministic; it does not change what caddy decides.
    for (const f of globSync(path.join(ROOT, '.aigent', 'cache', 'caddy-gap-*'))) {
      rmSync(f, { force: true });
    }
    const proc = spawnSync('bash', [path.join(ROOT, 'daemons', 'caddy.sh')], {
      input: c.prompt,
      env: { ...process.env, AIGENT_ROOT: ROOT },
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (proc.error) { record('skill-recall', c.id, 'unrunnable', `caddy.sh did not execute: ${proc.error.message}`); continue; }
    const out = proc.stdout || '';

    if (c.expect_no_match) {
      // NOT silence. caddy announces a miss ("No skill match") and that marker is
      // the correct answer — asserting silence here would fail on healthy output
      // and teach the next reader to delete the case.
      if (!/No skill match/i.test(out)) {
        record('skill-recall', c.id, 'fail', `expected a no-match; caddy said: ${out.trim().slice(0, 120) || '(silent)'}`);
        continue;
      }
    } else if (c.expected_skill) {
      const accepted = [c.expected_skill, ...(c.acceptable_alternatives || [])];
      if (!accepted.some((s) => out.includes(s))) {
        record('skill-recall', c.id, 'fail', `expected "${c.expected_skill}"; caddy said: ${out.trim().slice(0, 120) || '(silent)'}`);
        continue;
      }
    }
    const bad = (c.must_not_suggest || []).find((s) => out.includes(s));
    if (bad) { record('skill-recall', c.id, 'fail', `suggested forbidden skill "${bad}"`); continue; }
    record('skill-recall', c.id, 'pass', '');
  }
}

// ── Suite 2: capsule resume ───────────────────────────────────────────────────
// Writes one capsule at the given status into a temp vault and asks the REAL
// selector whether it is offered. This is the core product promise reduced to
// its smallest checkable claim.

async function runCapsuleResume() {
  const cases = loadCorpus('capsule-resume-tests.json');
  if (cases.__error) { record('capsule-resume', '-', 'unrunnable', `corpus unreadable: ${cases.__error}`); return; }

  let newestValidCapsule;
  // pathToFileURL, not a bare path: on Windows an absolute path is read as a
  // 'c:' protocol and the import fails for a reason unrelated to the selector.
  try { ({ newestValidCapsule } = await import(pathToFileURL(path.join(ROOT, 'daemons', 'lifecycle-common.mjs')).href)); }
  catch (e) { record('capsule-resume', '-', 'unrunnable', `selector import failed: ${e?.message}`); return; }

  for (const c of cases) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'eval-capsule-'));
    try {
      const capsules = path.join(dir, 'capsules');
      mkdirSync(capsules, { recursive: true });
      if (c.capsule_status !== null && c.capsule_status !== undefined) {
        writeFileSync(path.join(capsules, '2026-01-01-eval.md'), [
          '---',
          'id: 2026-01-01-eval',
          `status: ${c.capsule_status}`,
          'created_at: 2026-01-01T00:00:00Z',
          '---',
          '',
          '## Objective',
          'Evaluate the selector.',
          '',
          '## Next valid action',
          'Assert whether this capsule is offered.',
          '',
        ].join('\n'), 'utf8');
      }
      const offered = newestValidCapsule(dir) !== null;
      if (offered === c.expected_offer_resume) record('capsule-resume', c.id, 'pass', '');
      else {
        record('capsule-resume', c.id, 'fail',
          `status "${c.capsule_status}" -> offered=${offered}, expected ${c.expected_offer_resume}`);
      }
    } catch (e) {
      record('capsule-resume', c.id, 'unrunnable', `harness error: ${e?.message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ── Suite 3: contradiction ────────────────────────────────────────────────────
// Needs a model in the loop. Reported every run so the gap stays visible rather
// than being quietly absent from the scoreboard.

function runContradiction() {
  const cases = loadCorpus('contradiction-tests.json');
  if (cases.__error) { record('contradiction', '-', 'unrunnable', `corpus unreadable: ${cases.__error}`); return; }
  for (const c of cases) {
    record('contradiction', c.id, 'unrunnable',
      c.requires ? `declared gap: ${c.requires}` : 'needs a model harness; case does not declare `requires`');
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

await runCapsuleResume();
runSkillRecall();
runContradiction();

const declared = new Map();
for (const f of ['skill-recall-tests.json', 'capsule-resume-tests.json', 'contradiction-tests.json']) {
  const c = loadCorpus(f);
  if (!c.__error) for (const x of c) declared.set(x.id, x.requires || null);
}

// A DECLARED case that fails is a KNOWN GAP, not a regression — the assertion is
// kept on purpose to hold an open question open. A DECLARED case that PASSES is
// fatal: the gap closed and the declaration is now a lie. Without that second
// rule a `requires` marker becomes a permanent excuse nobody revisits, which is
// the failure mode this whole runner exists to end.
for (const r of results) {
  const req = declared.get(r.id);
  if (!req) continue;
  if (r.status === 'fail') { r.status = 'known-gap'; r.detail = `${req} — ${r.detail}`; }
  else if (r.status === 'pass') { r.status = 'gap-closed'; r.detail = `declared "${req}" but the case now PASSES — remove the declaration`; }
}

const pass = results.filter((r) => r.status === 'pass');
const fail = results.filter((r) => r.status === 'fail');
const knownGap = results.filter((r) => r.status === 'known-gap');
const gapClosed = results.filter((r) => r.status === 'gap-closed');
const unrunnable = results.filter((r) => r.status === 'unrunnable');
// An unrunnable case is fatal unless the case itself declares WHY it cannot run.
const undeclared = unrunnable.filter((r) => !declared.get(r.id));

const MARK = {
  pass: 'PASS', fail: 'FAIL', 'known-gap': 'KNOWN-GAP', 'gap-closed': 'GAP-CLOSED', unrunnable: 'UNRUNNABLE',
};

if (JSON_OUT) {
  console.log(JSON.stringify({
    pass: pass.length,
    fail: fail.length,
    known_gap: knownGap.length,
    gap_closed: gapClosed.length,
    unrunnable: unrunnable.length,
    undeclared: undeclared.length,
    results,
  }, null, 2));
} else {
  for (const r of results) {
    console.log(`  ${MARK[r.status].padEnd(11)} ${r.suite}/${r.id}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log('');
  console.log(`  ${pass.length} pass · ${fail.length} fail · ${knownGap.length} known-gap · ${unrunnable.length} unrunnable (${undeclared.length} undeclared)`);
  if (fail.length || undeclared.length || gapClosed.length) {
    console.log('');
    console.log('  RED. FAIL = behaviour drifted from the corpus. UNDECLARED unrunnable = the');
    console.log('  corpus asserts something this install cannot evaluate. GAP-CLOSED = a case');
    console.log('  declared as a known gap now passes, so the declaration is stale. In every');
    console.log('  case: fix the code or fix the declaration. Do not delete the assertion.');
  }
}

process.exit(fail.length || undeclared.length || gapClosed.length ? 1 : 0);
