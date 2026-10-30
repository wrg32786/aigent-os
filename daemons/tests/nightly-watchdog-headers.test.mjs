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
import { WATCHDOG_ALERT_CODES, assessNightlyCompletion, runNightlyWatchdog } from '../nightly-watchdog.mjs';

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

test('#122 a seat-local protocol with full structure is UNVERIFIED too: this reader cannot vouch for a format it does not know', async () => {
  const foreign = productBlock(PASS_DATE, { header: `## Nightly Pass -- ${PASS_DATE}` }).replace(`protocol: ${NIGHTLY_PROTOCOL}`, 'protocol: metis-local-v1-7L-7C');
  const root = fixture(foreign);
  const result = await run(root);
  assert.equal(result.ok, false);
  assert.equal(result.freshness.code, 'unverified');
  assert.match(result.freshness.detail, /protocol metis-local-v1-7L-7C, not close-parity/);
  assert.equal(raised(root, 'NIGHTLY:UNVERIFIED').length, 1);
  assert.equal(raised(root, 'NIGHTLY:NO_FIRE').length, 0);
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
