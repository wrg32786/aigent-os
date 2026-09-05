// shell-heredoc-quotes.test.mjs -- a bash 3.2 parse guard.
//
// macOS ships bash 3.2, which tracks quote state THROUGH the body of a heredoc
// that sits inside a command substitution while it scans for the closing
// parenthesis. One unpaired apostrophe in a Python comment inside doctor's
// attest heredoc opened a single-quoted string that never closed, and every
// macOS install died on "unexpected EOF while looking for matching '\"'".
// Nothing in the repo scores a bash 3.2 parse, so this witness scores the
// only property that matters for that scanner: inside every quoted heredoc
// that lives inside $( ... ), the counts of ' and " are even.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function shellFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'transport-deps'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.sh$/.test(entry.name)) out.push(full);
    }
  };
  for (const top of ['daemons', 'scripts', 'hooks', 'launcher', 'tests']) {
    if (existsSync(path.join(REPO, top))) walk(path.join(REPO, top));
  }
  for (const single of ['install.sh']) if (existsSync(path.join(REPO, single))) out.push(path.join(REPO, single));
  return out;
}

// Every heredoc introduced with a quoted delimiter (<<'TAG' or <<"TAG") whose
// opening line sits inside an open $( ... ). Depth is tracked naively by
// counting "$(" and ")" outside the heredoc bodies, which is enough for the
// shapes this repo uses (a heredoc fed to a command inside one substitution).
export function heredocsInsideSubstitution(text) {
  const lines = text.split('\n');
  const found = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const open = line.match(/<<-?\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1/);
    // The substitution that feeds the heredoc opens on the same line
    // (ATTEST_OUT="$(python3 - ... <<'ATTESTPY'), so the prefix before the
    // heredoc marker counts toward depth before the marker is judged.
    const prefix = open ? line.slice(0, line.indexOf(open[0])) : line;
    depth += (prefix.match(/\$\(/g) || []).length;
    depth -= (prefix.match(/\)/g) || []).length;
    if (depth < 0) depth = 0;
    if (open && depth > 0) {
      const tag = open[2];
      const body = [];
      let j = i + 1;
      while (j < lines.length && lines[j].replace(/^\t+/, '') !== tag) { body.push(lines[j]); j += 1; }
      found.push({ line: i + 1, tag, body: body.join('\n') });
      i = j;
    }
  }
  return found;
}

test('every quoted heredoc inside a command substitution has an even number of single and double quotes', () => {
  const offenders = [];
  let scanned = 0;
  for (const file of shellFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const doc of heredocsInsideSubstitution(text)) {
      scanned += 1;
      const single = (doc.body.match(/'/g) || []).length;
      const double = (doc.body.match(/"/g) || []).length;
      if (single % 2 !== 0 || double % 2 !== 0) {
        offenders.push(`${path.relative(REPO, file).split(path.sep).join('/')}:${doc.line} <<'${doc.tag}': ' x${single}, " x${double}`);
      }
    }
  }
  assert.ok(scanned >= 1, 'the attest heredoc in scripts/doctor.sh must be among the scanned bodies');
  assert.deepEqual(offenders, [], `bash 3.2 would read these as an unterminated quote:\n${offenders.join('\n')}`);
});

test('the guard itself goes red on one injected apostrophe', () => {
  const doctor = readFileSync(path.join(REPO, 'scripts', 'doctor.sh'), 'utf8');
  const docs = heredocsInsideSubstitution(doctor);
  assert.ok(docs.length >= 1, 'doctor.sh carries the attest heredoc inside $( )');
  const injected = doctor.replace(/(<<'ATTESTPY'\n)/, "$1# a comment with the seat's apostrophe\n");
  assert.notEqual(injected, doctor, 'the injection must land');
  const after = heredocsInsideSubstitution(injected);
  const single = (after[0].body.match(/'/g) || []).length;
  assert.equal(single % 2, 1, 'one injected apostrophe must make the count odd, which is what the first test refuses');
});
