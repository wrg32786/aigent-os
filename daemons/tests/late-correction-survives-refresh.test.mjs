import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, user, assistant, call, result, effectRows, fields } from './helpers/capsule-fixture.mjs';

const claim = 'Use X for the export';
const correction = 'Actually, do not use X. Use Y.';
const stop = { type: 'system', subtype: 'stop' };
function survives(prompt) {
  const operator = prompt.indexOf('  Recorded operator history');
  const claims = prompt.indexOf('  Done: claims to re-check');
  return operator >= 0 && claims > operator
    && prompt.slice(operator, claims).includes(`[OPERATOR] ${correction}`)
    && prompt.slice(claims).includes(`[ASSISTANT] ${claim}`)
    && prompt.includes('- All Done rows, including untagged rows, are claims to re-check before acting on or skipping them.');
}

test('F1: real writer and SessionStart clear resume carry a late correction', (t) => {
  const f = fixture(t);
  f.write([assistant(claim), user(correction), stop]);
  assert.equal(survives(f.resume()), true);
});

test('F2: correction belongs to operator history above Done claims and the claim fence', (t) => {
  const f = fixture(t);
  f.write([assistant(claim), user(correction), stop]);
  assert.equal(survives(f.resume()), true);
});

test('F3a: correction is the very last operator message before Stop', (t) => {
  const f = fixture(t);
  f.write([user('Prepare the export'), assistant(claim), user(correction), stop]);
  assert.equal(survives(f.resume()), true);
});

test('F3b: correction in a second Stop delta survives the refresh', (t) => {
  const f = fixture(t);
  f.write([assistant(claim), stop]);
  f.write([user(correction), stop]);
  assert.equal(survives(f.resume()), true);
});

test('F3c: correction reverses an already merged Done item while retaining both rows', (t) => {
  const f = fixture(t);
  assert.match(f.write([assistant(claim), stop]), /\[ASSISTANT\] Use X for the export/);
  const doc = f.write([user(correction), stop]);
  assert.match(doc, /\[ASSISTANT\] Use X for the export/);
  assert.ok(doc.includes(`[OPERATOR] ${correction}`));
  assert.equal(survives(f.resume()), true);
});

test('F4: deleting the correction event makes the same detector fail', (t) => {
  const events = [assistant(claim), user(correction), stop];
  const control = fixture(t);
  control.write(events);
  assert.equal(survives(control.resume()), true);
  const mutated = fixture(t);
  mutated.write(events.filter((event) => event.message?.content !== correction));
  assert.equal(survives(mutated.resume()), false);
});

test('F5: confirmed and requested side effects survive correction and clear resume', (t) => {
  for (const withResult of [true, false]) {
    const f = fixture(t);
    const doc = f.write([assistant(claim), call(), ...(withResult ? [result()] : []), user(correction), stop]);
    const rows = effectRows(doc);
    assert.equal(rows.length, 1);
    const parsed = fields(rows[0]);
    assert.equal(parsed.outcome, withResult ? 'confirmed' : 'requested');
    assert.equal(parsed.id, withResult ? 'msg_01TEST' : 'none');
    assert.equal(parsed.target, 'ops-channel');
    const prompt = f.resume();
    assert.equal(survives(prompt), true);
    assert.match(prompt, /requested or unknown: status-check by id before any retry; no id: ask the operator, do not resend\./);
    assert.ok(prompt.includes(`| outcome: ${parsed.outcome} | id "${parsed.id}"`));
  }
});
