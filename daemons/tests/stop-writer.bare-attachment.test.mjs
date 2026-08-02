// stop-writer.bare-attachment.test.mjs — a pasted path is not a directive.
//
// Real-glue: runs the REAL stop-capsule-writer worker over a real transcript
// delta in a temp seat. No mocks and no reimplementation of the predicate — a
// test that re-derives the regex would pass against a broken writer.
//
// LIVE SPECIMEN THIS DEFENDS (titus seat, 2026-08-01):
//   memory/capsules/2026-08-01-auto-titus-c9cc7d65.md
//   objective: "C:\\dev\\cockpit\\pasted\\2026-08-01T22-35-23-688Z-image.png"
// A pasted image path became the seat's stated objective.
//
// ⚑ RULED (titus, 2026-08-02, Room 6a4e10ae): a turn that is ONLY a pasted
// path/attachment is NOT an objective — it falls to the placeholder. "The
// placeholder is honest and correctly demoted since 1a1b303; a path-as-objective
// looks real, out-competes curated capsules, and poisons resume — the exact
// 0d6fb75c class." The trade against e9253777 (never invent an objective) was
// accepted explicitly: honest-empty beats plausible-garbage.
//
// Run: node daemons/tests/stop-writer.bare-attachment.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(HERE, '..', 'stop-capsule-writer.mjs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
};

function runWriter({ sid, userText }) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'bat-'));
  const root = path.join(base, 'test-seat');
  mkdirSync(path.join(root, 'memory', 'capsules'), { recursive: true });
  mkdirSync(path.join(root, 'memory', 'runtime', 'stop-writer'), { recursive: true });
  writeFileSync(path.join(root, 'memory', 'BODY_STATE.json'), JSON.stringify({ state: {} }));

  const transcript = path.join(base, 'transcript.jsonl');
  writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: userText } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'did the thing; delta ' + sid }] } }),
  ].join('\n') + '\n');

  execFileSync(process.execPath, [DAEMON, '--worker',
    JSON.stringify({ __root: root, session_id: sid, transcript_path: transcript })], { encoding: 'utf8' });

  const state = JSON.parse(readFileSync(path.join(root, 'memory', 'runtime', 'stop-writer', `${sid}.json`), 'utf8'));
  const doc = readFileSync(state.capsule_path, 'utf8');
  rmSync(base, { recursive: true, force: true });
  return doc;
}
const fm = (doc, key) => ((doc.match(new RegExp(`^${key}: (.*)$`, 'm')) || [])[1] || '');

console.log('stop-writer bare attachment');

// ── THE SPECIMEN, byte-exact from the titus capsule ──────────────────────────
{
  const doc = runWriter({
    sid: 'bat-specimen',
    userText: 'C:\\dev\\cockpit\\pasted\\2026-08-01T22-35-23-688Z-image.png',
  });
  const obj = fm(doc, 'objective');
  check('a lone pasted Windows path never becomes the objective',
    !/pasted/.test(obj) && !/\.png/.test(obj), `objective was ${obj}`);
  check('it falls to the honest placeholder instead',
    /Unknown|In-flight work/i.test(obj), `objective was ${obj}`);
}

// ── other lone-path shapes ───────────────────────────────────────────────────
{
  const doc = runWriter({ sid: 'bat-posix', userText: '/home/will/shot.jpeg' });
  check('a lone POSIX path is not an objective',
    !/shot\.jpeg/.test(fm(doc, 'objective')), `objective was ${fm(doc, 'objective')}`);
}
{
  const doc = runWriter({ sid: 'bat-quoted', userText: '"C:\\tmp\\a b\\diagram.svg"' });
  check('a QUOTED lone path is not an objective (quotes are the paste, not speech)',
    !/diagram\.svg/.test(fm(doc, 'objective')), `objective was ${fm(doc, 'objective')}`);
}
{
  const doc = runWriter({ sid: 'bat-rel', userText: './build/out.log' });
  check('a lone relative path is not an objective',
    !/out\.log/.test(fm(doc, 'objective')), `objective was ${fm(doc, 'objective')}`);
}

// ── NEGATIVE CONTROLS — a path INSIDE a directive is real human speech and the
//    directive must survive intact. A rule that eats these is eating the
//    operator's actual words, which is worse than the defect. ────────────────
{
  const doc = runWriter({
    sid: 'bat-neg-sentence',
    userText: 'fix the hero in C:\\dev\\theaigent-pages\\app\\page.tsx and push it',
  });
  const obj = fm(doc, 'objective');
  check('NEG: a path INSIDE a directive keeps the whole directive',
    /fix the hero/.test(obj) && /push it/.test(obj) && /page\.tsx/.test(obj), `objective was ${obj}`);
}
{
  const doc = runWriter({ sid: 'bat-neg-plain', userText: 'ship the SparkLoop pagination fix' });
  check('NEG: ordinary human text is untouched',
    /ship the SparkLoop pagination fix/.test(fm(doc, 'objective')), `objective was ${fm(doc, 'objective')}`);
}
{
  // A bare word is not a path. Over-broad "single token" matching would eat it.
  const doc = runWriter({ sid: 'bat-neg-word', userText: 'continue' });
  check('NEG: a lone ordinary word is still an objective',
    /continue/.test(fm(doc, 'objective')), `objective was ${fm(doc, 'objective')}`);
}
{
  // Not path-shaped: no separator. Must not be swallowed by an extension-only rule.
  const doc = runWriter({ sid: 'bat-neg-bare-file', userText: 'page.tsx' });
  check('NEG: a lone bare filename with no path separator stays an objective',
    /page\.tsx/.test(fm(doc, 'objective')), `objective was ${fm(doc, 'objective')}`);
}

// ── LEADING PASTE TOKEN FUSED TO REAL WORDS (board d25a884e) ─────────────────
// LIVE SPECIMEN THIS DEFENDS (pheme seat, 2026-08-02, fixture SYNTHESIZED —
// the principal's verbatim words stay out of this public repo; the shape was:
//   @"C:\Users\<user>\.claude\uploads\<sid>\<hash>-IMG_NNNN.PNG" <principal's real words about the image>
// The @"path" prefix is the harness paste decoration, not speech. RULED
// (titus, 2026-08-02, on-row): strip leading @-quoted/path-shaped attachment
// token(s) when real text follows — the human words stand VERBATIM as the
// objective. A LONE @-token is the 1043e52 placeholder class. A path (or @)
// inside the sentence stays load-bearing speech.
{
  const doc = runWriter({
    sid: 'bat-paste-fused',
    userText: '@"C:\\Users\\w\\.claude\\uploads\\abc123\\9f2e-IMG_0001.PNG" the hat still looks cut off, fix it',
  });
  const obj = fm(doc, 'objective');
  check('leading @"path" paste token is stripped; the words stand as the objective',
    /the hat still looks cut off, fix it/.test(obj) && !/IMG_0001/.test(obj) && !/@"/.test(obj),
    `objective was ${obj}`);
}
{
  const doc = runWriter({
    sid: 'bat-paste-lone',
    userText: '@"C:\\Users\\w\\.claude\\uploads\\abc123\\9f2e-IMG_0002.PNG"',
  });
  const obj = fm(doc, 'objective');
  check('a LONE @"path" paste token falls to the placeholder, same as 1043e52',
    !/IMG_0002/.test(obj) && /Unknown|In-flight work/i.test(obj), `objective was ${obj}`);
}
{
  const doc = runWriter({
    sid: 'bat-paste-multi',
    userText: '@"C:\\u\\a-1.png" @"C:\\u\\b-2.png" compare these two and tell me which is sharper',
  });
  const obj = fm(doc, 'objective');
  check('MULTIPLE leading paste tokens all strip; the directive survives whole',
    /compare these two and tell me which is sharper/.test(obj) && !/a-1\.png/.test(obj) && !/b-2\.png/.test(obj),
    `objective was ${obj}`);
}
{
  const doc = runWriter({
    sid: 'bat-paste-neg-mid',
    userText: 'load @"C:\\dev\\assets\\logo.svg" into the header and center it',
  });
  const obj = fm(doc, 'objective');
  check('NEG: an @-path INSIDE the sentence is load-bearing speech, untouched',
    /load/.test(obj) && /logo\.svg/.test(obj) && /center it/.test(obj), `objective was ${obj}`);
}
{
  const doc = runWriter({ sid: 'bat-paste-neg-mention', userText: '@titus should review the deploy first' });
  const obj = fm(doc, 'objective');
  check('NEG: a leading @-mention is not path-shaped and is never stripped',
    /@titus should review the deploy first/.test(obj), `objective was ${obj}`);
}

console.log(failures ? `\n${failures} FAILING` : '\nall green');
process.exit(failures ? 1 : 0);
