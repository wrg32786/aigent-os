// sessionstart-reinject.capsule-reread.test.mjs — the SessionStart
// warm-orientation capsule read (sessionstart-capsule-block.mjs's
// newestCapsuleBlock(), called from sessionstart-reinject.mjs) is a fourth
// site that touches a selected capsule after selection already validated its
// path. This proves the read re-validates containment immediately before
// touching the file — the same discipline resume-verb.mjs's own re-read
// already carries (see capsule-path-integrity.test.mjs) — instead of
// trusting selection's verdict after it has gone stale.
//
// Primary evidence uses the same portable technique capsule-path-integrity's
// "resume re-read" test uses: an injected fsImpl whose lstatSync starts
// reporting a symlink once the capsule has been read once (modeling the
// verdict going stale immediately after selection), with no dependency on
// the host's privilege to create a real symlink. This host cannot create
// file symlinks (SeCreateSymbolicLinkPrivilege is unavailable — confirmed:
// fs.symlinkSync(..., 'file') throws EPERM here even though directory
// junctions work fine), which is exactly why the existing suite treats a
// real native symlink as a skippable bonus, not the primary proof. A second,
// best-effort test below exercises a real symlink where the host permits it.
//
// unsafeRawCapsuleDocument (today's mechanism) takes NO fsImpl at all — it
// always reads through the real top-level readFileSync, so the fake stat
// cannot influence it. That is precisely the defect: the second read never
// consults any containment check, real or injected. The RED evidence is
// the two assertions that DISCRIMINATE: the render succeeds anyway despite
// the fsImpl reporting a symlink (no "became unreadable" degrade line), and
// no typed capsule-path-symlink refusal ever reaches the operator log.
// NOTE (R26 round-2 correction): the readFileSync COUNT does not
// discriminate. lifecycle-common.mjs imports readFileSync as a direct
// named binding, so the raw read bypasses the proxy entirely — the count
// is 1 under BOTH mechanisms (selector's guarded read only). The count
// assertion below is a PIN of the proxy-observable read population, not
// proof of the fix. The fix routes the same read through
// readContainedCapsuleDocument, which DOES consult fsImpl.lstatSync
// immediately before touching the file, so it refuses loudly instead.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newestCapsuleBlock } from '../sessionstart-capsule-block.mjs';

function capsuleDoc({
  id = 'sessionstart-toctou',
  createdAt = '2026-07-31T17:00:00.000Z',
  status = 'active',
  objective = 'Protect the warm-orientation capsule read',
} = {}) {
  return [
    '---',
    `id: ${id}`,
    `status: ${status}`,
    `objective: "${objective}"`,
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

function fixture() {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'sessionstart-toctou-'));
  const root = path.join(base, 'project');
  const memory = path.join(root, 'memory');
  const capsules = path.join(memory, 'capsules');
  const capsulePath = path.join(capsules, 'selected.md');
  const outsideCapsule = path.join(base, 'outside.md');
  fs.mkdirSync(capsules, { recursive: true });
  fs.writeFileSync(capsulePath, capsuleDoc());
  fs.writeFileSync(outsideCapsule, capsuleDoc({
    id: 'ATTACKER-OUTSIDE-ROOT',
    objective: 'ATTACKER-CONTROLLED OBJECTIVE — must never reach the rendered block',
  }));
  return {
    base, root, memory, capsules, capsulePath, outsideCapsule,
  };
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

// Mirrors sessionstart-reinject.mjs's own logErr(root, msg): append-only,
// same file name, same "never throw" discipline. newestCapsuleBlock() takes
// this as an injected callback (rather than hardcoding it) precisely so it
// stays a side-effect-free module safe to import directly in a test.
function makeLogErr(memory) {
  return (root, msg) => {
    try {
      fs.appendFileSync(
        path.join(memory, '.daemon-errors.log'),
        `${new Date().toISOString()} tag="test" message=${JSON.stringify(msg)}\n`,
      );
    } catch { /* truly nowhere to log */ }
  };
}

const symbolicLinkStat = {
  isSymbolicLink: () => true,
  isDirectory: () => false,
  isFile: () => false,
};

test('warm-orientation read re-validates containment instead of reusing a stale selection verdict', () => {
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
        // Selection's own guarded read sees an ordinary file. The instant
        // those bytes are read, the path's verdict goes stale — modeling a
        // symlink/junction/out-of-root swap completing in that gap, exactly
        // as the fix order describes.
        if (isCapsule && capsuleReads >= 1) return symbolicLinkStat;
        return fs.lstatSync(candidate);
      },
    });

    const lines = newestCapsuleBlock(f.root, f.memory, { fsImpl, logErr: makeLogErr(f.memory) });
    const rendered = lines.join('\n');

    assert.match(
      rendered,
      /became unreadable \(logged\)/,
      'a refused re-read takes the documented degrade path, not a silent success — '
      + `got: ${JSON.stringify(rendered)}`,
    );
    assert.equal(
      capsuleReads,
      1,
      'the guarded selector read stays the only proxy-observable read '
      + '(a PIN, constant across the fix — the raw read bypassed the proxy; see header)',
    );
    assert.match(
      fs.readFileSync(path.join(f.memory, '.daemon-errors.log'), 'utf8'),
      /capsule-path-symlink/,
      'the operator log names the typed refusal, not a generic failure',
    );
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('warm-orientation read still renders the ordinary, unswapped capsule', () => {
  const f = fixture();
  try {
    const lines = newestCapsuleBlock(f.root, f.memory);
    const rendered = lines.join('\n');
    assert.match(rendered, /NEWEST ACTIVE CAPSULE/);
    assert.match(rendered, /Protect the warm-orientation capsule read/);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('no valid capsule degrades to the orient-with-/open message, never throws', () => {
  const f = fixture();
  try {
    fs.rmSync(f.capsulePath);
    const lines = newestCapsuleBlock(f.root, f.memory);
    assert.match(lines.join('\n'), /No valid active capsule\. Run \/open to orient\./);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('native out-of-root symlink is refused where the host permits creating one', (t) => {
  const f = fixture();
  try {
    try {
      fs.unlinkSync(f.capsulePath);
      fs.symlinkSync(f.outsideCapsule, f.capsulePath, 'file');
    } catch (error) {
      // Restore an ordinary file so the finally-block cleanup and any other
      // process touching this fixture never trips on a half-swapped state.
      fs.writeFileSync(f.capsulePath, capsuleDoc());
      t.skip(`file symlink creation unavailable: ${error?.code || error}`);
      return;
    }

    const lines = newestCapsuleBlock(f.root, f.memory);
    const rendered = lines.join('\n');
    assert.doesNotMatch(
      rendered,
      /ATTACKER-CONTROLLED OBJECTIVE/,
      'attacker bytes from the swapped-in out-of-root capsule must never reach the rendered block',
    );
    assert.match(rendered, /became unreadable \(logged\)/);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});
