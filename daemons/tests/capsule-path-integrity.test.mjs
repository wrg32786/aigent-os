// capsule-path-integrity.test.mjs — F003 lifecycle filesystem containment.
//
// A selected capsule is touched three times: selector read, resume re-read, and
// consume write.  These tests keep those sites separate so one guarded read
// cannot accidentally stand in for all three.  The injected fs implementations
// model committed interleavings that native test code cannot schedule between
// adjacent synchronous filesystem calls; native junction/symlink cases remain
// alongside them to exercise the host filesystem where permissions allow.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  markCapsuleConsumed,
  selectCapsule,
} from '../lifecycle-common.mjs';
import { runResumeVerb } from '../resume-verb.mjs';

function capsuleDoc({
  id = 'capsule-path-integrity',
  createdAt = '2026-07-31T17:00:00.000Z',
  status = 'active',
} = {}) {
  return [
    '---',
    `id: ${id}`,
    `status: ${status}`,
    'objective: "Protect capsule filesystem boundaries"',
    'waiting_on: "the containment gate"',
    'next_valid_action: "run the focused integrity tests"',
    `created_at: ${createdAt}`,
    '---',
    '',
    '# Body',
    'Every byte outside the status scalar must survive.',
    '',
  ].join('\n');
}

function fixture(prefix = 'capsule-path-') {
  const base = fs.mkdtempSync(path.join(tmpdir(), prefix));
  const root = path.join(base, 'project');
  const memory = path.join(root, 'memory');
  const capsules = path.join(memory, 'capsules');
  const capsulePath = path.join(capsules, 'selected.md');
  fs.mkdirSync(capsules, { recursive: true });
  fs.writeFileSync(capsulePath, capsuleDoc());
  return { base, root, memory, capsules, capsulePath };
}

function delegatedFs(overrides) {
  return new Proxy(fs, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return overrides[property];
      }
      return Reflect.get(target, property);
    },
  });
}

const symbolicLinkStat = {
  isSymbolicLink: () => true,
  isDirectory: () => false,
  isFile: () => false,
};

test('selector read refuses a capsule-file symlink with a typed, loud rejection', () => {
  const f = fixture();
  try {
    const fsImpl = delegatedFs({
      lstatSync(candidate) {
        if (path.resolve(String(candidate)) === path.resolve(f.capsulePath)) return symbolicLinkStat;
        return fs.lstatSync(candidate);
      },
    });

    const result = selectCapsule(f.memory, { fsImpl });

    assert.equal(result.capsule, null, 'a symlink must never supply selector bytes');
    assert.equal(result.unavailable, 'all-candidates-rejected');
    assert.deepEqual(result.rejected.map(({ name, reason }) => ({ name, reason })), [{
      name: 'selected.md',
      reason: 'capsule-path-symlink',
    }]);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('selector read uses canonical realpath containment, not a sibling string prefix', () => {
  const f = fixture();
  const sibling = path.join(f.memory, 'capsules-backup');
  const escaped = path.join(sibling, 'selected.md');
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(escaped, capsuleDoc({ id: 'escaped' }));
  try {
    // Model a reparse point that lstat did not identify: the candidate's
    // canonical destination lives in `capsules-backup`, whose name still starts
    // with `capsules`.  A string-prefix check accepts it; path.relative does not.
    const fsImpl = delegatedFs({
      realpathSync(candidate) {
        if (path.resolve(String(candidate)) === path.resolve(f.capsulePath)) return escaped;
        return fs.realpathSync(candidate);
      },
    });

    const result = selectCapsule(f.memory, { fsImpl });

    assert.equal(result.capsule, null);
    assert.equal(result.rejected[0]?.reason, 'capsule-path-outside-root');
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('resume re-read rechecks after selection and degrades loudly instead of following a swapped link', () => {
  const f = fixture();
  let capsuleReads = 0;
  try {
    const fsImpl = delegatedFs({
      readFileSync(candidate, ...args) {
        const isCapsule = path.resolve(String(candidate)) === path.resolve(f.capsulePath);
        const value = fs.readFileSync(candidate, ...args);
        if (isCapsule) capsuleReads += 1;
        return value;
      },
      lstatSync(candidate) {
        const isCapsule = path.resolve(String(candidate)) === path.resolve(f.capsulePath);
        // The selector's guarded read sees a regular file.  Immediately after
        // those bytes are read, the resume touch sees the committed swap.
        if (isCapsule && capsuleReads >= 1) return symbolicLinkStat;
        return fs.lstatSync(candidate);
      },
    });

    const result = runResumeVerb({
      projectRoot: f.root,
      source: 'clear',
      sessionId: 'resume-reread-race',
      fsImpl,
    });

    assert.equal(result.degraded, true, 'a refused re-read takes the documented degraded path');
    assert.equal(result.loaded, null);
    assert.equal(capsuleReads, 1, 'the unsafe second read never occurs');
    assert.ok(result.rejected.some((entry) => entry.reason === 'capsule-path-symlink'));
    assert.match(result.prompt, /capsule-path-symlink/,
      'the session-facing rejection ledger names the refusal');
    assert.match(fs.readFileSync(path.join(f.memory, '.daemon-errors.log'), 'utf8'),
      /capsule-path-symlink/,
      'the operator log names the same typed refusal');
    assert.match(fs.readFileSync(f.capsulePath, 'utf8'), /^status: active$/m,
      'a refused resume cannot consume the path it would not re-read');
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('consume commit rechecks the final path after staging and refuses final-path drift', () => {
  const f = fixture();
  let staged = false;
  let renameCalls = 0;
  try {
    const fsImpl = delegatedFs({
      writeFileSync(candidate, ...args) {
        const result = fs.writeFileSync(candidate, ...args);
        if (path.resolve(String(candidate)) !== path.resolve(f.capsulePath)) staged = true;
        return result;
      },
      lstatSync(candidate) {
        const isFinal = path.resolve(String(candidate)) === path.resolve(f.capsulePath);
        if (isFinal && staged) return symbolicLinkStat;
        return fs.lstatSync(candidate);
      },
      renameSync(...args) {
        renameCalls += 1;
        return fs.renameSync(...args);
      },
    });

    assert.throws(
      () => markCapsuleConsumed(f.capsulePath, f.memory, { fsImpl }),
      (error) => error?.code === 'ECAPSULEPATH'
        && error?.reason === 'capsule-path-symlink'
        && error?.stage === 'consume-final-commit',
    );
    assert.equal(renameCalls, 0, 'no final write occurs after boundary drift');
    assert.match(fs.readFileSync(f.capsulePath, 'utf8'), /^status: active$/m);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('resume verb catches a typed consume refusal, logs it, and never crashes the turn', () => {
  const f = fixture();
  let staged = false;
  try {
    const fsImpl = delegatedFs({
      writeFileSync(candidate, ...args) {
        const result = fs.writeFileSync(candidate, ...args);
        if (path.resolve(String(candidate)) !== path.resolve(f.capsulePath)) staged = true;
        return result;
      },
      lstatSync(candidate) {
        const isFinal = path.resolve(String(candidate)) === path.resolve(f.capsulePath);
        if (isFinal && staged) return symbolicLinkStat;
        return fs.lstatSync(candidate);
      },
    });

    const result = runResumeVerb({
      projectRoot: f.root,
      source: 'clear',
      sessionId: 'consume-refusal',
      fsImpl,
    });

    assert.equal(result.degraded, false, 'the safely re-read capsule still reaches the prompt');
    assert.equal(result.loaded?.id, 'capsule-path-integrity');
    assert.match(fs.readFileSync(path.join(f.memory, '.daemon-errors.log'), 'utf8'),
      /mark-consumed FAILED.*capsule-path-symlink.*consume-final-commit/,
      'the fail-open verb names the typed refusal in its operator-visible stream');
    assert.match(fs.readFileSync(f.capsulePath, 'utf8'), /^status: active$/m,
      'refusal preserves the final capsule for recovery');
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('consume commit rechecks its temporary path and refuses a swapped staging file', () => {
  const f = fixture();
  let stagedPath = null;
  let renameCalls = 0;
  try {
    const fsImpl = delegatedFs({
      writeFileSync(candidate, ...args) {
        const result = fs.writeFileSync(candidate, ...args);
        if (path.resolve(String(candidate)) !== path.resolve(f.capsulePath)) stagedPath = String(candidate);
        return result;
      },
      lstatSync(candidate) {
        if (stagedPath && path.resolve(String(candidate)) === path.resolve(stagedPath)) {
          return symbolicLinkStat;
        }
        return fs.lstatSync(candidate);
      },
      renameSync(...args) {
        renameCalls += 1;
        return fs.renameSync(...args);
      },
    });

    assert.throws(
      () => markCapsuleConsumed(f.capsulePath, f.memory, { fsImpl }),
      (error) => error?.code === 'ECAPSULEPATH'
        && error?.reason === 'capsule-path-symlink'
        && error?.stage === 'consume-temporary-commit',
    );
    assert.equal(renameCalls, 0, 'a refused temporary path cannot be committed');
    assert.match(fs.readFileSync(f.capsulePath, 'utf8'), /^status: active$/m);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('consume refuses a Windows junction in the parent chain without touching its target', (t) => {
  const f = fixture('capsule-junction-');
  const outside = path.join(f.base, 'outside');
  const junction = path.join(f.capsules, 'linked-parent');
  const outsideCapsule = path.join(outside, 'outside.md');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(outsideCapsule, capsuleDoc({ id: 'outside-junction-target' }));
  try {
    try {
      fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`directory link creation unavailable: ${error?.code || error}`);
      return;
    }

    assert.throws(
      () => markCapsuleConsumed(path.join(junction, 'outside.md'), f.memory),
      (error) => error?.code === 'ECAPSULEPATH' && error?.reason === 'capsule-path-symlink',
    );
    assert.match(fs.readFileSync(outsideCapsule, 'utf8'), /^status: active$/m,
      'the junction target remains byte-for-byte unconsumed');
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('consume refuses a lexical escape into a sibling-prefix directory', () => {
  const f = fixture();
  const sibling = path.join(f.memory, 'capsules-backup');
  const outsideCapsule = path.join(sibling, 'outside.md');
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(outsideCapsule, capsuleDoc({ id: 'outside-prefix' }));
  try {
    assert.throws(
      () => markCapsuleConsumed(outsideCapsule, f.memory),
      (error) => error?.code === 'ECAPSULEPATH' && error?.reason === 'capsule-path-outside-root',
    );
    assert.match(fs.readFileSync(outsideCapsule, 'utf8'), /^status: active$/m);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('consume requires an authoritative memory root instead of deriving trust from its target', () => {
  const f = fixture();
  try {
    assert.throws(
      () => markCapsuleConsumed(f.capsulePath),
      (error) => error?.code === 'ECAPSULEPATH'
        && error?.reason === 'capsules-root-required'
        && error?.stage === 'consume-authority',
    );
    assert.match(fs.readFileSync(f.capsulePath, 'utf8'), /^status: active$/m);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('safe consume preserves every byte except the active status token and leaves no staging file', () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.capsulePath, 'utf8');
    assert.equal(markCapsuleConsumed(f.capsulePath, f.memory), true);
    const after = fs.readFileSync(f.capsulePath, 'utf8');
    assert.equal(after, before.replace(/^status: active$/m, 'status: resumed'));
    assert.deepEqual(
      fs.readdirSync(f.capsules).filter((name) => name.includes('.consume-')),
      [],
      'successful commit renames its staging file rather than leaking it',
    );
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('native capsule-file symlink is refused where the host permits creating one', (t) => {
  const f = fixture();
  const outside = path.join(f.base, 'outside.md');
  const linked = path.join(f.capsules, 'linked.md');
  fs.writeFileSync(outside, capsuleDoc({ id: 'native-link', createdAt: '2026-08-01T00:00:00Z' }));
  try {
    try {
      fs.symlinkSync(outside, linked, 'file');
    } catch (error) {
      t.skip(`file symlink creation unavailable: ${error?.code || error}`);
      return;
    }

    const result = selectCapsule(f.memory);
    assert.equal(result.capsule?.path, f.capsulePath, 'the ordinary capsule still wins');
    assert.equal(
      result.rejected.find((entry) => entry.name === 'linked.md')?.reason,
      'capsule-path-symlink',
    );
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});
