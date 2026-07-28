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
const record = (suite, id, status, detail, extra = {}) => results.push({ suite, id, status, detail, ...extra });

// Duplicate ids inside one corpus collide on the per-case router session id and
// produce a confusing "(silent)" failure whose cause is invisible. Cheap to reject
// at load; expensive to diagnose at 2am.
function duplicateIds(cases) {
  const seen = new Set(); const dupes = new Set();
  for (const c of cases || []) { if (seen.has(c?.id)) dupes.add(c.id); seen.add(c?.id); }
  return [...dupes];
}

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
    // Give every case its OWN session id. caddy suppresses its no-match line once
    // per session (caddy.sh:193-194), and a caller that sends no session_id keys
    // that flag on the literal "unknown" — one bucket shared by every session-less
    // caller on the install, including any live agent session firing the same hook.
    // Clearing the shared flag instead of avoiding it was both flaky and rude: it
    // deleted other sessions' state, and a live session could recreate the flag
    // between the clear and the spawn. Measured at 1 failure in 5 runs, always the
    // negative case, always "caddy said: (silent)" — a green suite that goes red
    // depending on what else is running is not a gate.
    const evalSession = `eval-${process.pid}-${c.id}`;
    const proc = spawnSync('bash', [path.join(ROOT, 'daemons', 'caddy.sh')], {
      input: JSON.stringify({ prompt: c.prompt, session_id: evalSession }),
      env: { ...process.env, AIGENT_ROOT: ROOT },
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (proc.error) { record('skill-recall', c.id, 'harness-error', `caddy.sh did not execute: ${proc.error.message}`); continue; }
    const out = proc.stdout || '';

    // A case with neither a positive nor a negative expectation asserts NOTHING:
    // both branches below are skipped, must_not_suggest is empty in every case,
    // and it recorded PASS while caddy's output was discarded. An assertion that
    // cannot fail is worse than an absent one, because it inflates the pass count.
    if (!c.expect_no_match && !c.expected_skill) {
      record('skill-recall', c.id, 'harness-error',
        'case declares neither expected_skill nor expect_no_match — it asserts nothing and can never fail');
      continue;
    }

    // An empty or falsy needle matches EVERY string, because out.includes('') is
    // always true. One '' in acceptable_alternatives rescues any wrong answer:
    // a case pointed at the wrong skill with alternatives [''] passed against a
    // FULLY DEAD router while three siblings went red in the same run. This is the
    // same defect as an assertion-free case, one level down — the case declares an
    // expectation, but the expectation cannot fail. A trailing-comma edit produces
    // it by accident.
    // Type-check the FIELD before its entries. A JSON string instead of an array
    // spreads into single characters, each a non-empty string, so an entry-level
    // check passes and `out.includes('s')` then matches essentially any response.
    // "acceptable_alternatives": "scout-vault" is one missing bracket pair.
    const badShape = ['acceptable_alternatives', 'must_not_suggest']
      .find((k) => c[k] !== undefined && !Array.isArray(c[k]));
    if (badShape) {
      record('skill-recall', c.id, 'harness-error',
        `${badShape} must be an array; a bare string spreads into single characters that match anything`);
      continue;
    }
    const emptyNeedle = [...(c.acceptable_alternatives || []), ...(c.must_not_suggest || [])]
      .some((s) => typeof s !== 'string' || s === '');
    if (emptyNeedle) {
      record('skill-recall', c.id, 'harness-error',
        'acceptable_alternatives/must_not_suggest contains an empty or non-string entry — it matches every response and cannot fail');
      continue;
    }

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
    // `matched` records whether the router actually resolved a skill, as distinct
    // from the case merely passing. Only a real match can witness that routing works.
    record('skill-recall', c.id, 'pass', '', { matched: !/No skill match/i.test(out) });
  }
  // A no-match assertion is satisfied by a router that is COMPLETELY DEAD: total
  // failure emits the same "No skill match" the case expects. Measured — with the
  // scorer stubbed to return nothing, the negative case PASSED while three
  // positive siblings went red in the same run. So a negative result only carries
  // information when the router has proven, in this same run, that it can still
  // match something. Without that pairing the case cannot detect under-firing,
  // because under-firing is what produces its expected output.
  const mine = results.filter((r) => r.suite === 'skill-recall');
  const negativeIds = new Set(cases.filter((c) => c.expect_no_match).map((c) => c.id));
  // The witness must have MATCHED, not merely passed. caddy's miss line names a
  // real installed skill ("run /skill-recall to log this gap"), so a positive case
  // expecting `skill-recall` passes identically whether the router works or is
  // completely dead — a witness satisfied by the very failure it is meant to rule
  // out. Only a case whose response was NOT a miss proves routing still works.
  const positivesPassed = mine.some((r) => !negativeIds.has(r.id) && r.status === 'pass' && r.matched === true);
  const hasPositives = cases.some((c) => !c.expect_no_match);
  if (hasPositives && !positivesPassed) {
    for (const r of mine) {
      if (negativeIds.has(r.id) && r.status === 'pass') {
        r.status = 'harness-error';
        r.detail = 'no-match assertion is unverifiable: zero positive cases passed this run, so a dead router would satisfy it identically';
      }
    }
  }

  // Clean up only the flags this run created. Never touch another session's.
  for (const f of globSync(path.join(ROOT, '.aigent', 'cache', `caddy-gap-eval-${process.pid}-*`))) {
    rmSync(f, { force: true });
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
      // NOT 'unrunnable': that status is excusable by a `requires` declaration,
      // and the selector throwing is a defect, not an absent precondition.
      record('capsule-resume', c.id, 'harness-error', `harness error: ${e?.message}`);
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

// Keyed by suite/id, NEVER by bare id. Case ids are unique only WITHIN a corpus,
// so a bare-id map let a `requires` marker in one suite silence a same-named case
// in another: renaming contradiction's ct-001 to sr-001 downgraded a live routing
// FAIL to KNOWN-GAP and exited 0. A declaration may only ever excuse the case that
// declared it.
const declared = new Map();
for (const [suite, f] of [
  ['skill-recall', 'skill-recall-tests.json'],
  ['capsule-resume', 'capsule-resume-tests.json'],
  ['contradiction', 'contradiction-tests.json'],
]) {
  const c = loadCorpus(f);
  if (!c.__error) for (const x of c) declared.set(`${suite}/${x.id}`, x.requires || null);
}
const declarationFor = (r) => declared.get(`${r.suite}/${r.id}`);

for (const [suite, f] of [
  ['skill-recall', 'skill-recall-tests.json'],
  ['capsule-resume', 'capsule-resume-tests.json'],
  ['contradiction', 'contradiction-tests.json'],
]) {
  const c = loadCorpus(f);
  if (c.__error) continue;
  for (const id of duplicateIds(c)) {
    record(suite, id, 'harness-error', 'duplicate case id in corpus — cases collide on the per-case router session and fail with a misleading symptom');
  }
}

// A DECLARED case that fails is a KNOWN GAP, not a regression — the assertion is
// kept on purpose to hold an open question open. A DECLARED case that PASSES is
// fatal: the gap closed and the declaration is now a lie. Without that second
// rule a `requires` marker becomes a permanent excuse nobody revisits, which is
// the failure mode this whole runner exists to end.
for (const r of results) {
  const req = declarationFor(r);
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
const undeclared = unrunnable.filter((r) => !declarationFor(r));

// HARNESS-ERROR is never excusable. `requires` declares a missing PRECONDITION
// ("needs a model in the loop"); it must not absorb the machinery breaking. A
// thrown selector crash previously landed as unrunnable, was excused by the
// case's own declaration, dropped out of the scoreboard entirely, and exited 0 —
// a production crash reading as a known gap, which is the exact failure this
// runner exists to end. Kept as a separate status so no declaration can reach it.
const harnessError = results.filter((r) => r.status === 'harness-error');

// A corpus that asserts nothing is green by vacuum. Emptying both executable
// corpora to [] previously produced 0 pass / 0 fail / exit 0. Coverage that can
// silently reach zero is not coverage.
// Counted over EXECUTED rows only. Counting every row let declared-unrunnable
// satisfy the floor: pointing all five skill-recall cases at an absent skill with
// a `requires` marker produced 5 rows >= the floor, 0 undeclared, exit 0, and
// caddy was never invoked once. Reachable one case at a time by a reasonable
// person — rename a skill, the case goes undeclared-unrunnable and turns CI red,
// and the cheapest green is adding `requires` rather than fixing the corpus. Each
// step defensible, the suite inert. A row is not an assertion.
// `known-gap` is deliberately EXCLUDED. It executes, but it is also non-fatal, so
// counting it let a declaration buy coverage it never pays for: with every
// positive case declared and the router fully dead, four known-gaps satisfied a
// floor of four and the suite exited 0 over a router that matched nothing. That is
// the SAME ratchet closed one round earlier for `unrunnable` — fixing the instance
// and leaving the identical door open next to it. The floor now counts only rows
// that both ran AND could have failed the build.
const EXECUTED = new Set(['pass', 'fail']);
const MIN_EXECUTABLE = { 'skill-recall': 4, 'capsule-resume': 4 };
const starved = Object.entries(MIN_EXECUTABLE)
  .map(([suite, min]) => [suite, results.filter((r) => r.suite === suite && EXECUTED.has(r.status)).length, min])
  .filter(([, n, min]) => n < min);

const MARK = {
  pass: 'PASS', fail: 'FAIL', 'known-gap': 'KNOWN-GAP', 'gap-closed': 'GAP-CLOSED',
  unrunnable: 'UNRUNNABLE', 'harness-error': 'HARNESS-ERR',
};

if (JSON_OUT) {
  console.log(JSON.stringify({
    pass: pass.length,
    fail: fail.length,
    known_gap: knownGap.length,
    gap_closed: gapClosed.length,
    unrunnable: unrunnable.length,
    undeclared: undeclared.length,
    harness_error: harnessError.length,
    starved: starved.map(([suite, n, min]) => ({ suite, cases: n, minimum: min })),
    results,
  }, null, 2));
} else {
  for (const r of results) {
    console.log(`  ${MARK[r.status].padEnd(11)} ${r.suite}/${r.id}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log('');
  console.log(`  ${pass.length} pass · ${fail.length} fail · ${knownGap.length} known-gap · ${gapClosed.length} gap-closed · ${harnessError.length} harness-error · ${unrunnable.length} unrunnable (${undeclared.length} undeclared)`);
  for (const [suite, n, min] of starved) {
    console.log(`  STARVED: suite "${suite}" ran ${n} case(s), minimum ${min}. Coverage cannot silently reach zero.`);
  }
  if (fail.length || undeclared.length || gapClosed.length || harnessError.length || starved.length) {
    console.log('');
    console.log('  RED. FAIL = behaviour drifted from the corpus. UNDECLARED unrunnable = the');
    console.log('  corpus asserts something this install cannot evaluate. GAP-CLOSED = a case');
    console.log('  declared as a known gap now passes, so the declaration is stale. HARNESS-ERR');
    console.log('  = the machinery itself broke, and no `requires` declaration can excuse it.');
    console.log('  STARVED = a suite lost cases. In every case: fix the code or fix the');
    console.log('  declaration. Do not delete the assertion.');
  }
}

process.exit(
  fail.length || undeclared.length || gapClosed.length || harnessError.length || starved.length ? 1 : 0,
);
