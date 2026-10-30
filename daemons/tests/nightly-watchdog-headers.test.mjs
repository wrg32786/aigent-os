// Issue #122: both nightly header shapes are read, and a recognised run whose
// evidence this reader cannot verify is UNVERIFIED, never PASS and never a
// false NO_FIRE. Healthy, failing, missed and abandoned controls sit beside the
// new vectors so the distinctions stay measurable. Fixtures live in temp dirs.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { newestDatedHeader } from '../nightly-freshness.mjs';
import { NIGHTLY_CHECKPOINTS, NIGHTLY_PROTOCOL } from '../nightly-pass.mjs';
import { readNightlyAlertEvents } from '../nightly-alerts.mjs';
import { WATCHDOG_ALERT_CODES, assessNightlyCompletion, parseNightlyProtocol, runNightlyWatchdog } from '../nightly-watchdog.mjs';

const PASS_DATE = '2026-03-10';
// 2026-03-10 23:30 in Los Angeles: past the 04:00 cutoff, so the expected night is PASS_DATE.
const NOW = new Date('2026-03-11T06:30:00.000Z');
const TIME_ZONE = 'America/Los_Angeles';
const CUTOFF_HOUR = 4;
const roots = [];

function fixture(logText) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'aigent-watchdog-headers-'));
  roots.push(base);
  const root = path.join(base, 'seat');
  const runtime = path.join(root, 'vault', 'memory', 'runtime');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(path.join(runtime, 'NIGHTLY_LOG.md'), logText, 'utf8');
  return root;
}

function run(root) {
  return runNightlyWatchdog({ root, now: NOW, deliver: false, persist: true, timeZone: TIME_ZONE, cutoffHour: CUTOFF_HOUR });
}

function raised(root, code) {
  return readNightlyAlertEvents(root).events.filter((event) => event.code === code && event.event === 'raised');
}

// The product's own block: every checkpoint, honest status, receipts.
function productBlock(date, { status = 'PASS', failed = [], header = `## Nightly Pass -- ${date} (${date}-fixture)` } = {}) {
  return [
    header,
    `protocol: ${NIGHTLY_PROTOCOL}`,
    `status: ${status}`,
    `completed_at: ${date}T19:05:00.000Z`,
    `time_zone: ${TIME_ZONE}`,
    `cutoff_hour: ${CUTOFF_HOUR}`,
    ...NIGHTLY_CHECKPOINTS.map((checkpoint) => {
      const red = failed.includes(checkpoint);
      return `- ${checkpoint}: status=${red ? 'FAIL' : 'PASS'} exit=${red ? 1 : 0} validator=FIXTURE_RECEIPT`;
    }),
    '',
  ].join('\n');
}

// The operator-journal shape measured on the metis vault (issue #122), verbatim
// in form: em dash, a time range after the date, prose underneath.
const JOURNAL_HEADER = `## Pass 89 \u2014 ${PASS_DATE}T14:26\u201314:4xZ`;
const JOURNAL_BLOCK = [
  JOURNAL_HEADER,
  '',
  'Fire: `6dbf818e` dispatched **14:26:40.329Z against an 11:00Z schedule**. **7/7 legs ran.**',
  '',
  '- **Leg A /dream \u2014 RAN.** 5 candidates.',
  '- **Leg B /reconcile \u2014 RAN.** 56 capsules.',
  '',
].join('\n');

test.after(() => {
  for (const base of roots) rmSync(base, { recursive: true, force: true });
});

test('#122 both header shapes name the same date key; the newest is found across them', () => {
  const text = [
    '## Nightly Pass -- 2026-10-15 (pass 76)',
    'protocol: x',
    '## Pass 88 \u2014 2026-10-27T11:00\u201311:0xZ',
    'prose',
    '## Pass 89 \u2014 2026-10-28T14:26\u201314:4xZ',
    'prose',
    '## Pass 90 -- 2026-10-28',
    '## Pass 91 \u2013 2026-10-29',
    '',
  ].join('\n');
  const { newest, dates } = newestDatedHeader(text, 'nightly');
  assert.equal(newest, '2026-10-29');
  assert.deepEqual(dates, ['2026-10-15', '2026-10-27', '2026-10-28', '2026-10-28', '2026-10-29']);
  // What follows the date is not part of the key; a longer digit run is not a date.
  assert.equal(newestDatedHeader('## Nightly Pass -- 2026-10-299\n', 'nightly').newest, null);
  assert.equal(newestDatedHeader('## Pass 7 \u2014 2026-10-28T00:00Z\n', 'nightly').newest, '2026-10-28');
});

test('#122 a journal-shape run with no machine-readable evidence is UNVERIFIED: not PASS, not NO_FIRE, its own alert', async () => {
  const root = fixture(JOURNAL_BLOCK);
  const completion = assessNightlyCompletion({ file: path.join(root, 'vault', 'memory', 'runtime', 'NIGHTLY_LOG.md'), date: PASS_DATE, timeZone: TIME_ZONE, cutoffHour: CUTOFF_HOUR });
  assert.equal(completion.ok, false);
  assert.equal(completion.code, 'unverified');
  assert.match(completion.detail, /no machine-readable evidence block/);
  const result = await run(root);
  assert.equal(result.ok, false);
  assert.equal(result.freshness.code, 'unverified', 'the header was found (the night fired); the evidence could not be read');
  assert.equal(result.freshness.newest, PASS_DATE, 'MUST be red before the fix: the em-dash header was invisible, so newest was null and the verdict was a false NO_FIRE');
  assert.match(result.output, /^NIGHTLY_WATCHDOG RED code=unverified/);
  assert.equal(raised(root, 'NIGHTLY:UNVERIFIED').length, 1);
  assert.equal(raised(root, 'NIGHTLY:NO_FIRE').length, 0, 'a run that fired is never a no-fire');
  assert.equal(raised(root, 'NIGHTLY:PASS_FAILED').length, 0);
});

// A seat-local protocol, shaped like the metis vault's own: seven receipted rows,
// its own names, the id declaring the count.
const METIS_ROWS = ['dream', 'reconcile', 'sweep-now', 'digest', 'system-check', 'ledger-review', 'vault-sync'];
function metisBlock(date, { rows = METIS_ROWS, header = `## Nightly Pass -- ${date}`, zone = true } = {}) {
  return [
    header,
    'Legs run: 7/7 | Legs skipped: 0',
    '',
    'protocol: metis-local-v1-7L-7C',
    'status: PASS',
    `completed_at: ${date}T11:10:00Z`,
    ...(zone ? [`time_zone: ${TIME_ZONE}`, `cutoff_hour: ${CUTOFF_HOUR}`] : []),
    '',
    ...rows.map((row) => `- ${row}: status=PASS exit=0 validator=scripts/${row}.py`),
    '',
  ].join('\n');
}

test('#122 the protocol id declares the shape: metis-local-v1-7L-7C with seven receipted rows is GREEN; six of seven is incomplete; an id with no shape is unverified', async () => {
  assert.deepEqual(parseNightlyProtocol('metis-local-v1-7L-7C'), { legs: 7, checkpoints: 7 });
  assert.deepEqual(parseNightlyProtocol(NIGHTLY_PROTOCOL), { legs: 7, checkpoints: 11 });
  assert.equal(parseNightlyProtocol('journal'), null);
  const green = fixture(metisBlock(PASS_DATE));
  const ok = await run(green);
  assert.equal(ok.ok, true, ok.freshness.detail);
  assert.match(ok.completion.detail, /completed metis-local-v1-7L-7C evidence block with 7\/7 checkpoints/);
  assert.equal(raised(green, 'NIGHTLY:NO_FIRE').length, 0);
  // Metis's falsifier: delete ONE row and the same block must read incomplete; a reader that stopped checking would still say green.
  const sixOfSeven = fixture(metisBlock(PASS_DATE, { rows: METIS_ROWS.filter((row) => row !== 'digest') }));
  const short = await run(sixOfSeven);
  assert.equal(short.ok, false);
  assert.equal(short.freshness.code, 'incomplete');
  assert.match(short.freshness.detail, /checkpoints=6 of 7 recorded/);
  assert.equal(raised(sixOfSeven, 'NIGHTLY:NO_FIRE').length, 1, 'an abandoned seat-local pass is still a no-fire');
  // Eight rows against a seven-count declaration is wrong the other way.
  const eight = fixture(metisBlock(PASS_DATE, { rows: [...METIS_ROWS, 'extra'] }));
  const over = await run(eight);
  assert.equal(over.freshness.code, 'incomplete');
  assert.match(over.freshness.detail, /unknown_checkpoints=8 recorded, 7 declared/);
  // An id that declares no shape cannot be checked: unverified, not a no-fire.
  const shapeless = fixture(metisBlock(PASS_DATE).replace('protocol: metis-local-v1-7L-7C', 'protocol: journal'));
  const unverified = await run(shapeless);
  assert.equal(unverified.freshness.code, 'unverified');
  assert.match(unverified.freshness.detail, /names no shape/);
  assert.equal(raised(shapeless, 'NIGHTLY:UNVERIFIED').length, 1);
  assert.equal(raised(shapeless, 'NIGHTLY:NO_FIRE').length, 0);
});

test('#122 a block without time_zone / cutoff_hour means the defaults and is GREEN; a present value still has to agree', async () => {
  const plain = fixture(metisBlock(PASS_DATE, { zone: false }));
  const ok = await run(plain);
  assert.equal(ok.ok, true, ok.freshness.detail);
  const wrongZone = fixture(metisBlock(PASS_DATE).replace(`time_zone: ${TIME_ZONE}`, 'time_zone: Europe/Berlin'));
  const red = await run(wrongZone);
  assert.equal(red.freshness.code, 'incomplete');
  assert.match(red.freshness.detail, /time_zone=Europe\/Berlin/);
});

test('#122 a later green resolves every earlier active alert of the code, whatever night it was scoped to, and the announcer no longer shows them', async () => {
  const root = fixture(`## Nightly Pass -- 2026-03-08\nprotocol: ${NIGHTLY_PROTOCOL}\n`);
  const stale = await run(root);
  assert.equal(stale.ok, false);
  const before = readNightlyAlertEvents(root).events.filter((event) => event.event === 'raised').map((event) => event.alert_id);
  assert.ok(before.length >= 1);
  writeFileSync(path.join(root, 'vault', 'memory', 'runtime', 'NIGHTLY_LOG.md'), metisBlock(PASS_DATE), 'utf8');
  const green = await run(root);
  assert.equal(green.ok, true, green.freshness.detail);
  assert.ok(green.resolved >= 1);
  const { readActiveNightlyAlerts } = await import('../nightly-alerts.mjs');
  assert.deepEqual(readActiveNightlyAlerts(root).alerts, [], 'the original lines stand; a later resolved record per alert_id is what the announcer reads');
  for (const id of before) assert.ok(readNightlyAlertEvents(root).events.some((event) => event.alert_id === id && event.event === 'resolved'), id);
});

test('#122 healthy control: a full block in this protocol is GREEN and resolves a standing UNVERIFIED alert', async () => {
  const root = fixture(JOURNAL_BLOCK);
  const first = await run(root);
  assert.equal(first.ok, false);
  assert.equal(raised(root, 'NIGHTLY:UNVERIFIED').length, 1);
  // The seat later writes the product's own block for the same night.
  writeFileSync(path.join(root, 'vault', 'memory', 'runtime', 'NIGHTLY_LOG.md'), `${JOURNAL_BLOCK}\n${productBlock(PASS_DATE)}`, 'utf8');
  const second = await run(root);
  assert.equal(second.ok, true, second.freshness.detail);
  assert.match(second.output, /^NIGHTLY_WATCHDOG GREEN/);
  const resolved = readNightlyAlertEvents(root).events.filter((event) => event.code === 'NIGHTLY:UNVERIFIED' && event.event === 'resolved');
  assert.equal(resolved.length, 1, 'green clears every code the watchdog can raise, the new one included');
  assert.ok(WATCHDOG_ALERT_CODES.includes('NIGHTLY:UNVERIFIED'));
});

test('#122 failing control: a full block that reports FAIL is still fired-and-failed, never unverified', async () => {
  const root = fixture(productBlock(PASS_DATE, { status: 'FAIL', failed: ['dream'] }));
  const result = await run(root);
  assert.equal(result.ok, false);
  assert.equal(result.freshness.code, 'failed');
  assert.equal(raised(root, 'NIGHTLY:PASS_FAILED').length, 1);
  assert.equal(raised(root, 'NIGHTLY:UNVERIFIED').length, 0);
  assert.equal(raised(root, 'NIGHTLY:NO_FIRE').length, 0);
});

test('#122 missed and abandoned nights still read as NO_FIRE', async () => {
  // Missed: the newest header, in either shape, is two nights old.
  const stale = fixture([
    `## Pass 12 \u2014 2026-03-08T11:00\u201311:0xZ`,
    'prose',
    productBlock('2026-03-08'),
  ].join('\n'));
  const missed = await run(stale);
  assert.equal(missed.ok, false);
  assert.notEqual(missed.freshness.code, 'unverified');
  assert.equal(raised(stale, 'NIGHTLY:NO_FIRE').length, 1);
  // Abandoned: this protocol's block for the right night, three checkpoints never written.
  const abandoned = fixture(productBlock(PASS_DATE).split('\n').filter((line) => !/^- (vault-sync|ledger-review|ledger-capture):/.test(line)).join('\n'));
  const incomplete = await run(abandoned);
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.freshness.code, 'incomplete');
  assert.match(incomplete.freshness.detail, /checkpoints=ledger-capture,ledger-review,vault-sync/);
  assert.equal(raised(abandoned, 'NIGHTLY:NO_FIRE').length, 1);
  assert.equal(raised(abandoned, 'NIGHTLY:UNVERIFIED').length, 0);
});

test('#129 review: a prose journal entry appended AFTER a complete product block for the same night does not flip GREEN to unverified', async () => {
  const root = fixture(`${productBlock(PASS_DATE)}\n## Pass 90 \u2014 ${PASS_DATE}T11:00\u201311:0xZ\n\nprose only, written after the product block\n`);
  const result = await run(root);
  assert.equal(result.ok, true, 'MUST be red on 0b5d49cb: only the last header for the date was scored');
  assert.equal(result.completion.code, 'complete');
  assert.equal(raised(root, 'NIGHTLY:UNVERIFIED').length, 0);
  // And the other way round: the journal entry first, the product block after, same answer.
  const reversed = fixture(`## Pass 90 \u2014 ${PASS_DATE}T11:00\u201311:0xZ\n\nprose\n\n${productBlock(PASS_DATE)}`);
  assert.equal((await run(reversed)).ok, true);
  // A night whose blocks are a failed run and then a complete run reads complete: the night was made good.
  const recovered = fixture(`${productBlock(PASS_DATE, { status: 'FAIL', failed: ['dream'] })}\n${productBlock(PASS_DATE)}`);
  assert.equal((await run(recovered)).completion.code, 'complete');
});

test('#129 review: a protocol declaring zero checkpoints never reads complete; all-skipped rows never read complete', async () => {
  const zero = fixture(metisBlock(PASS_DATE, { rows: [] }).replace('metis-local-v1-7L-7C', 'metis-local-v1-7L-0C'));
  const z = await run(zero);
  assert.equal(z.ok, false, 'MUST be red on 0b5d49cb: expectedCount 0 made an empty block complete');
  assert.equal(z.freshness.code, 'incomplete');
  assert.match(z.freshness.detail, /checkpoints_declared=0/);
  const skipped = fixture(metisBlock(PASS_DATE).replace(/status=PASS exit=0/g, 'status=SKIPPED exit=0'));
  const k = await run(skipped);
  assert.equal(k.ok, false, 'MUST be red on 0b5d49cb: seven SKIPPED rows read as seven checkpoints');
  assert.equal(k.freshness.code, 'incomplete');
  assert.match(k.freshness.detail, /no checkpoint ran \(all rows skipped\)/);
  assert.equal(raised(skipped, 'NIGHTLY:NO_FIRE').length, 1);
});

test('#129 review: another close-parity version is unverifiable by this build, never verified by count; the exact id keeps the name rules', async () => {
  const older = fixture(productBlock(PASS_DATE).replace(`protocol: ${NIGHTLY_PROTOCOL}`, 'protocol: close-parity-v1-7L-11C'));
  const v1 = await run(older);
  assert.equal(v1.ok, false, 'MUST be red on 0b5d49cb: a non-exact product id degraded to a count check and passed');
  assert.equal(v1.freshness.code, 'unverified');
  assert.match(v1.freshness.detail, /cannot verify another product version by count/);
  // Exact id: an illegal skip is still illegal, an unknown name still unknown.
  const skip = fixture(productBlock(PASS_DATE).replace('- dream: status=PASS exit=0', '- dream: status=SKIPPED exit=0'));
  const illegal = await run(skip);
  assert.equal(illegal.freshness.code, 'incomplete');
  assert.match(illegal.freshness.detail, /illegal_skips=dream/);
});

test('#129 review: an honest FAIL in an unverifiable format is fired-and-failed with its checkpoints named, never unverified', async () => {
  const block = metisBlock(PASS_DATE).replace('protocol: metis-local-v1-7L-7C', 'protocol: journal').replace('status: PASS', 'status: FAIL').replace('- digest: status=PASS exit=0', '- digest: status=FAIL exit=1');
  const root = fixture(block);
  const result = await run(root);
  assert.equal(result.ok, false);
  assert.equal(result.freshness.code, 'failed', 'MUST be red on 0b5d49cb: the unverified return ran before the FAIL check');
  assert.match(result.freshness.detail, /fired and failed: digest/);
  assert.equal(raised(root, 'NIGHTLY:PASS_FAILED').length, 1);
  assert.equal(raised(root, 'NIGHTLY:UNVERIFIED').length, 0);
  const alert = raised(root, 'NIGHTLY:PASS_FAILED')[0];
  assert.match(alert.summary, /digest/);
});

test('#129 review: absent time_zone / cutoff_hour mean the run\'s own configuration, also under a non-default --time-zone', async () => {
  // 12:00Z is 13:00 in Berlin, past a 04:00 cutoff: the expected night is PASS_DATE there too.
  const root = fixture(metisBlock(PASS_DATE, { zone: false }));
  const result = await runNightlyWatchdog({ root, now: new Date(`${PASS_DATE}T12:00:00.000Z`), deliver: false, persist: false, timeZone: 'Europe/Berlin', cutoffHour: 4 });
  assert.equal(result.ok, true, result.freshness.detail);
  assert.equal(result.freshness.newest, PASS_DATE);
});
