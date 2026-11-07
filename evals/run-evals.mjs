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
// DRIVES THE REAL SOURCE. capsule-resume calls newestValidCapsule() from
// daemons/lifecycle-common.mjs against a temp vault; it never re-implements the
// logic it checks — a mirror stays green when the daemon regresses. (The
// skill-recall suite, which drove daemons/caddy.sh, was retired with Caddy.)
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
// `extra` is spread FIRST so it can never overwrite a row's own verdict. No call
// site passes corpus-controlled data today, but a status field a caller can
// rewrite is a loaded gun waiting for the round.
const record = (suite, id, status, detail, extra = {}) => results.push({ ...extra, suite, id, status, detail });

// Duplicate ids inside one corpus collide on the per-case router session id and
// produce a confusing "(silent)" failure whose cause is invisible. Cheap to reject
// at load; expensive to diagnose at 2am.
function duplicateIds(cases) {
  const seen = new Set(); const dupes = new Set();
  for (const c of cases || []) { if (seen.has(c?.id)) dupes.add(c.id); seen.add(c?.id); }
  return [...dupes];
}

// Duplicates are reported AND skipped. Reporting alone left the duplicate cases
// executing, which inflated the pass count and fed the coverage floor with rows
// the corpus never intended. It could not yield green (the error rows are fatal in
// the same run), but a count nobody can trust is not worth keeping.
function withoutDuplicates(cases) {
  const seen = new Set();
  return (cases || []).filter((c) => (seen.has(c?.id) ? false : (seen.add(c?.id), true)));
}

function loadCorpus(name) {
  try { return JSON.parse(readFileSync(path.join(EVALS, name), 'utf8')); }
  catch (e) { return { __error: e?.message || String(e) }; }
}

// ── Suite 1 (skill recall) retired 2026-11-05 ─────────────────────────────────
// It drove prompts through daemons/caddy.sh. Caddy is retired: Claude Code matches skills
// natively from each skill's description, so there is no router of ours left to evaluate.

// ── Suite 2: capsule resume ───────────────────────────────────────────────────
// Writes one capsule at the given status into a temp vault and asks the REAL
// selector whether it is offered. This is the core product promise reduced to
// its smallest checkable claim.

async function runCapsuleResume() {
  const cases = loadCorpus('capsule-resume-tests.json');
  if (cases.__error) { record('capsule-resume', '-', 'unrunnable', `corpus unreadable: ${cases.__error}`); return; }
  const uniqueCases = withoutDuplicates(cases);

  let newestValidCapsule;
  // pathToFileURL, not a bare path: on Windows an absolute path is read as a
  // 'c:' protocol and the import fails for a reason unrelated to the selector.
  try { ({ newestValidCapsule } = await import(pathToFileURL(path.join(ROOT, 'daemons', 'lifecycle-common.mjs')).href)); }
  catch (e) { record('capsule-resume', '-', 'unrunnable', `selector import failed: ${e?.message}`); return; }

  for (const c of uniqueCases) {
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
  const uniqueCases = withoutDuplicates(cases);
  for (const c of uniqueCases) {
    record('contradiction', c.id, 'unrunnable',
      c.requires ? `declared gap: ${c.requires}` : 'needs a model harness; case does not declare `requires`');
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

await runCapsuleResume();
runContradiction();

// Keyed by suite/id, NEVER by bare id. Case ids are unique only WITHIN a corpus,
// so a bare-id map let a `requires` marker in one suite silence a same-named case
// in another: renaming contradiction's ct-001 to sr-001 downgraded a live routing
// FAIL to KNOWN-GAP and exited 0. A declaration may only ever excuse the case that
// declared it.
const declared = new Map();
for (const [suite, f] of [
  ['capsule-resume', 'capsule-resume-tests.json'],
  ['contradiction', 'contradiction-tests.json'],
]) {
  const c = loadCorpus(f);
  if (!c.__error) for (const x of c) declared.set(`${suite}/${x.id}`, x.requires || null);
}
const declarationFor = (r) => declared.get(`${r.suite}/${r.id}`);

for (const [suite, f] of [
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
// TWO separate properties, because collapsing them into one floor put honesty in
// tension with coverage: with a hard floor of 4 over undeclared rows, a suite of 5
// carrying one legitimate declared gap sat exactly on the boundary, so declaring a
// SECOND real gap turned the build red. A maintainer telling the truth should never
// trip a gate. Split them:
//   STARVED     — the suite lost cases outright. Absolute floor, catches attrition.
//   UNDERCOVERED — declarations ate the coverage. Relative, so honest gaps have room
//                  while "declare everything" still cannot buy a green.
const EXECUTED = new Set(['pass', 'fail']);
const MIN_CASES = { 'capsule-resume': 4 };
const suiteRows = (s) => results.filter((r) => r.suite === s).length;
const suiteExecuted = (s) => results.filter((r) => r.suite === s && EXECUTED.has(r.status)).length;

const starved = Object.entries(MIN_CASES)
  .map(([suite, min]) => [suite, suiteRows(suite), min])
  .filter(([, n, min]) => n < min);

const undercovered = Object.keys(MIN_CASES)
  .map((suite) => [suite, suiteExecuted(suite), Math.ceil(suiteRows(suite) / 2)])
  .filter(([suite, n, need]) => suiteRows(suite) > 0 && n < need);

// UNWITNESSED — a suite with positive cases must contain at least one pass the
// TRIGGER SCORER resolved. Without this, `matched` was consulted in exactly one
// place (the negative-case witness rule) and therefore only mattered when the
// corpus happened to contain an expect_no_match row. Nothing required such a row
// to exist. Delete the negative case — the likeliest one to be deleted, since it
// was the flaky one before session isolation — and four taxonomy-resolved passes
// satisfied both STARVED and UNDERCOVERED with scorer coverage at exactly zero.
// This makes scorer liveness a property of the suite rather than a courtesy
// extended to negative cases.
// KNOWN LATENT FALSE NEGATIVE, recorded so it is not a surprise: daemons/skill-router.sh
// is a THIRD resolver emitting "[CADDY:skill] MATCH". It cannot spoof `matched`
// (colon-prefixed), but a corpus whose positives ALL resolve through it would have
// no witness and go red while healthy. Red-when-healthy is the safe direction and
// it is loud, so it is left; no current corpus prompt reaches that path.
const witnessedSuites = new Set(
  results.filter((r) => r.status === 'pass' && r.matched === true).map((r) => r.suite),
);
const unwitnessed = []
  .filter((s) => results.some((r) => r.suite === s && EXECUTED.has(r.status)) && !witnessedSuites.has(s));

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
    undercovered: undercovered.map(([suite, n, need]) => ({ suite, executed: n, needs: need })),
    unwitnessed,
    results,
  }, null, 2));
} else {
  for (const r of results) {
    console.log(`  ${MARK[r.status].padEnd(11)} ${r.suite}/${r.id}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log('');
  console.log(`  ${pass.length} pass · ${fail.length} fail · ${knownGap.length} known-gap · ${gapClosed.length} gap-closed · ${harnessError.length} harness-error · ${unrunnable.length} unrunnable (${undeclared.length} undeclared)`);
  for (const [suite, n, min] of starved) {
    console.log(`  STARVED: suite "${suite}" has ${n} case(s), minimum ${min}. Coverage cannot silently reach zero.`);
  }
  for (const [suite, n, need] of undercovered) {
    console.log(`  UNDERCOVERED: suite "${suite}" has only ${n} undeclared executed case(s) of ${suiteRows(suite)} rows, needs ${need}. Either declarations ate the coverage or unrunnable rows inflated the denominator.`);
  }
  for (const suite of unwitnessed) {
    console.log(`  UNWITNESSED: suite "${suite}" has no scorer-resolved pass. Every passing case was answered by a fallback resolver, so the trigger scorer could be entirely dead.`);
  }
  if (fail.length || undeclared.length || gapClosed.length || harnessError.length || starved.length || undercovered.length || unwitnessed.length) {
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
  fail.length || undeclared.length || gapClosed.length || harnessError.length
    || starved.length || undercovered.length || unwitnessed.length ? 1 : 0,
);
