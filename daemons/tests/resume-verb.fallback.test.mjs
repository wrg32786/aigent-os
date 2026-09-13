// resume-verb.fallback.test.mjs -- resume-verb.mjs throw-only fallback.
//
// loadLifecycleExtension() is documented to never throw and to always return
// resume_preload/resume_reground as arrays (see daemons/lifecycle-extension.mjs).
// runResumeVerb() wraps the call in a try/catch as defense in depth for that
// promise. The fallback object used ONLY when the call throws anyway omitted
// both array fields, so a caller iterating result.extension.resume_preload on
// that path read undefined instead of [].
//
// A non-string projectRoot forces the throw: loadLifecycleExtension() joins
// it into a path with no guard, and path.join(null, ...) throws before the
// function's own try/catch (around the file read) is reached. Everything
// upstream of that call tolerates a non-string projectRoot (it stringifies
// or fails closed as a MemoryRootError, both handled), so this reaches the
// fallback without any other path in runResumeVerb short-circuiting first.
//
// Run: node --test daemons/tests/resume-verb.fallback.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { runResumeVerb } from '../resume-verb.mjs';

test('W-D1: the throw-only fallback still carries resume_preload and resume_reground as empty arrays', () => {
  const result = runResumeVerb({ projectRoot: null, source: 'clear', sessionId: 'sid-w-d1' });
  assert.ok(Array.isArray(result.extension.resume_preload),
    `resume_preload must be an array, got ${JSON.stringify(result.extension.resume_preload)}`);
  assert.equal(result.extension.resume_preload.length, 0);
  assert.ok(Array.isArray(result.extension.resume_reground),
    `resume_reground must be an array, got ${JSON.stringify(result.extension.resume_reground)}`);
  assert.equal(result.extension.resume_reground.length, 0);
});
