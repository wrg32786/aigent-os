// capsule-lib.mjs - shared capsule logic for the context-capsule plugin.
// Plain ESM, Node 18+, zero dependencies, no network.
//
// Ported from aigent-os: daemons/frontmatter-reader.cjs (scalar / hasFrontmatter /
// inline-comment and null checks), daemons/capsule-verb.mjs (validateCapsuleText),
// daemons/capsule-content-gate.mjs (injection-echo and ceremony gate) and
// daemons/lifecycle-common.mjs (selectCapsule, markCapsuleConsumed, inert).
// The capsule file format is unchanged, so a later full aigent-os install reads
// the same files.
//
// Also a tiny CLI so the /capsule command writes deterministically:
//   node capsule-lib.mjs dir                      print the resolved capsule dir
//   node capsule-lib.mjs write --objective ... --waiting-on ... --next-action ... [--slug s] [--body-file f]
//   node capsule-lib.mjs validate <file>
//   node capsule-lib.mjs newest                   print the newest valid capsule path

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync, lstatSync, realpathSync, linkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { CAPSULE_SECTIONS } from './capsule-sections.mjs';

export const REQUIRED_FIELDS = Object.freeze(['id', 'objective', 'waiting_on', 'next_valid_action']);
export const CONSUMED_STATUSES = new Set(['resumed', 'resolved', 'consumed', 'superseded']);
export const DEFAULT_MAX_AGE_DAYS = 14;
export const INJECTION_BUDGET = 1800; // chars; the whole SessionStart injection stays under this

// ---------- frontmatter reader (port of daemons/frontmatter-reader.cjs) ----------

const LINE_BREAKING = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const esc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const collapse = (v) => (v === null || v === undefined ? v : String(v).replace(LINE_BREAKING, ' '));

function rawFrontmatter(doc) { return String(doc ?? '').match(FRONTMATTER)?.[1] ?? null; }

function rawScalarToken(doc, key) {
  const fm = rawFrontmatter(doc);
  if (fm === null) return null;
  const re = new RegExp(`^${esc(key)}:[ \\t]*([^\\r\\n]*)$`);
  for (const line of fm.split(/\r\n|\n|\r/)) {
    const m = line.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

function inlineCommentIndex(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (quote === '"') { if (c === '\\') i += 1; else if (c === '"') quote = null; continue; }
    if (quote === "'") {
      if (c === "'" && raw[i + 1] === "'") i += 1; else if (c === "'") quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) return i;
  }
  return -1;
}

function decodeScalar(raw) {
  let v = String(raw).trim();
  const ci = inlineCommentIndex(v);
  if (ci >= 0) v = v.slice(0, ci).trimEnd();
  if (v.startsWith('"') && v.endsWith('"')) {
    try { const p = JSON.parse(v); if (typeof p === 'string') return p; } catch { /* fall through */ }
    return v.slice(1, -1);
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

// `key: >` / `key: |` block scalars fold to one line.
function blockScalarFold(doc, key) {
  const fm = rawFrontmatter(doc);
  if (fm === null) return undefined;
  const lines = fm.split(/\r\n|\n|\r/);
  const re = new RegExp(`^${esc(key)}:[ \\t]*([^\\r\\n]*)$`);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(re);
    if (!m) continue;
    if (!/^[>|][+-]?$/.test(m[1].trim())) return undefined;
    const got = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j] === '') continue;
      if (/^[ \t]/.test(lines[j])) { got.push(lines[j]); continue; }
      break;
    }
    const folded = collapse(got.join(' ')).replace(/[ \t]+/g, ' ').trim();
    return folded.length ? folded : null;
  }
  return undefined;
}

export function hasFrontmatter(doc) { return rawFrontmatter(doc) !== null; }

export function scalar(doc, key) {
  const folded = blockScalarFold(doc, key);
  if (folded !== undefined) return folded;
  const raw = rawScalarToken(doc, key);
  return raw === null ? null : collapse(decodeScalar(raw));
}

function scalarHasInlineComment(doc, key) {
  const raw = rawScalarToken(doc, key);
  return raw !== null && inlineCommentIndex(raw) >= 0;
}

function scalarIsUnquotedNull(doc, key) {
  const raw = rawScalarToken(doc, key);
  if (raw === null || raw.startsWith('"') || raw.startsWith("'")) return false;
  const ci = inlineCommentIndex(raw);
  return /^(?:null|~)$/i.test((ci >= 0 ? raw.slice(0, ci) : raw).trim());
}

// ---------- content gate (port of daemons/capsule-content-gate.mjs) ----------

const INJECTION_TEMPLATES = [
  /^\[supervisor-resume\]/i, /^\[refresh-cycle\]/i, /^\[auto-pull\]/i, /^\[context-refresh\b/i,
  /^\[capsule-request\]/i, /^\[room from /i, /^\[inbox\b/i, /^# Autonomous loop check/i,
  /^Autonomous loop tick/i, /^<task-notification>/i, /^\[SYSTEM NOTIFICATION/i,
];
const CEREMONY_PATTERNS = [
  /^re-?read the (active )?turn state\b/i, /^resume from the latest session log\b/i,
  /^resume (is |was )?(now )?complete\b/i, /^(the )?receipt (is |was )?written\b/i,
  /^RESUME-ACK\b/, /^comply with (any|the) supervisor-resume instruction\b/i,
];
const matches = (list, s) => { const t = String(s || '').trim(); return !!t && list.some((re) => re.test(t)); };

export function contentProblems(fields) {
  const problems = [];
  if (matches(INJECTION_TEMPLATES, fields?.objective)) {
    problems.push('objective is harness-injection echo, not a real objective (content gate)');
  }
  if (matches(CEREMONY_PATTERNS, fields?.next_valid_action)) {
    problems.push('next_valid_action opens with resume ceremony; a fresh session cannot act on it (content gate)');
  }
  return problems;
}

// ---------- validation (port of validateCapsuleText) ----------

export function validateCapsuleText(text) {
  if (!hasFrontmatter(text)) return { fields: {}, problems: ['capsule must begin with a closed YAML frontmatter block'] };
  const fields = {};
  const problems = [];
  for (const f of REQUIRED_FIELDS) {
    fields[f] = scalar(text, f);
    if (typeof fields[f] !== 'string' || fields[f].trim().length === 0) problems.push(`frontmatter ${f} must be non-empty`);
    if (scalarHasInlineComment(text, f)) problems.push(`frontmatter ${f} must not use an inline YAML comment`);
  }
  if (scalarIsUnquotedNull(text, 'waiting_on')) problems.push('frontmatter waiting_on must be non-empty (unquoted YAML null is empty)');
  problems.push(...contentProblems(fields));
  return { fields, problems };
}

// ---------- paths and settings ----------

export function projectDir(payload = {}) {
  return process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
}

// userConfig values reach hooks as CLAUDE_PLUGIN_OPTION_<KEY>; accept the case variants.
function configuredCapsuleDir() {
  for (const k of ['CLAUDE_PLUGIN_OPTION_CAPSULEDIR', 'CLAUDE_PLUGIN_OPTION_capsuleDir', 'CLAUDE_PLUGIN_OPTION_CAPSULE_DIR']) {
    const v = process.env[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

// `explicit` is a --dir value from the command line. A Bash tool call does not receive the plugin's
// CLAUDE_PLUGIN_OPTION_* variables (hooks do), so /capsule passes the configured dir as --dir.
// What Claude Code leaves in plugin text when an option is unset.
const UNSUBSTITUTED = /^\$\{user_config\.[A-Za-z0-9_]+\}$/;

export function capsuleDir(payload = {}, explicit = '') {
  const project = projectDir(payload);
  const given = typeof explicit === 'string' ? explicit.trim() : '';
  const set = given && !UNSUBSTITUTED.test(given) ? given : configuredCapsuleDir();
  if (!set) return path.join(project, '.claude', 'capsules');
  return path.resolve(project, set);
}

// ---------- coexistence with a full aigent-os install ----------
// install.sh writes <root>/.aigent/state.json (schemaVersion/status/completedAt) on
// every install, and the managed settings template wires sessionstart-reinject.mjs,
// resume-verb.mjs and precompact-flush.mjs. Either signal means aigent-os already
// owns capsule + resume, so this plugin stays silent to avoid a second capsule or a
// second injection.
const AIGENT_HOOK_RE = /(sessionstart-reinject|resume-verb|precompact-flush)\.mjs/;

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

function settingsHaveAigentHooks(file) {
  const j = readJson(file);
  if (!j || typeof j.hooks !== 'object' || j.hooks === null) return false;
  for (const event of ['SessionStart', 'PreCompact']) {
    for (const group of Array.isArray(j.hooks[event]) ? j.hooks[event] : []) {
      for (const h of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (typeof h?.command === 'string' && AIGENT_HOOK_RE.test(h.command)) return true;
      }
    }
  }
  return false;
}

// Claude Code user profile dir: CLAUDE_CONFIG_DIR when set (trimmed, non-empty), else ~/.claude.
export function userConfigDir() {
  const c = (process.env.CLAUDE_CONFIG_DIR || '').trim();
  if (c) return c;
  try { return path.join(homedir(), '.claude'); } catch { return ''; }
}

export function detectAigentOs(payload = {}) {
  const roots = [...new Set([projectDir(payload), process.env.AIGENT_ROOT].filter(Boolean))];
  // User scope: hooks in the user profile settings fire in every project.
  const userDir = userConfigDir();
  if (userDir) {
    for (const f of ['settings.json', 'settings.local.json']) {
      const p = path.join(userDir, f);
      if (settingsHaveAigentHooks(p)) return { detected: true, why: `aigent-os hooks in ${p}` };
    }
  }
  for (const root of roots) {
    const state = readJson(path.join(root, '.aigent', 'state.json'));
    if (state && typeof state === 'object' && 'schemaVersion' in state) {
      return { detected: true, why: `${path.join(root, '.aigent', 'state.json')} (install marker)` };
    }
    for (const f of ['settings.json', 'settings.local.json']) {
      const p = path.join(root, '.claude', f);
      if (settingsHaveAigentHooks(p)) return { detected: true, why: `aigent-os hooks in ${p}` };
    }
  }
  return { detected: false, why: '' };
}

// ---------- storage containment ----------

// A capsule or marker is only touched when it is a regular file (not a link) whose real path
// sits inside the capsule directory's real path. Anything else is treated as not ours.
export function isContainedFile(dir, file) {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    const root = realpathSync(dir);
    const rel = path.relative(root, realpathSync(file));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch { return false; }
}

// ---------- selection (port of selectCapsule, without the reuse tier) ----------

// Returns { capsule, rejected: [{name, reason, detail?}] }. capsule = newest valid
// active capsule by created_at. Corrupt, spent, incomplete or stale capsules are
// listed in `rejected` with a reason; none is ever loaded.
// Same-second saves are <stamp>.md (1st), <stamp>-2.md, ...; later saves have the higher number.
// Plain name order is wrong here because '-' sorts before '.'.
function saveOrder(name) {
  const m = name.match(/^.*-\d{6}(?:-(\d+))?\.md$/);
  return m ? (m[1] ? Number(m[1]) : 1) : 0;
}

export function selectCapsule(dir, { maxAgeDays = DEFAULT_MAX_AGE_DAYS, now = Date.now() } = {}) {
  const rejected = [];
  const note = (name, reason, detail) => rejected.push({ name, reason, ...(detail ? { detail } : {}) });
  if (!dir || !existsSync(dir)) return { capsule: null, rejected, missingDir: true };
  let entries;
  try { entries = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md')); } catch { return { capsule: null, rejected, missingDir: true }; }
  let best = null;
  let newestResumed = -Infinity; // an adopted continuation: nothing older may be auto-injected behind it
  const actives = [];
  for (const name of entries) {
    const full = path.join(dir, name);
    if (!isContainedFile(dir, full)) { note(name, 'unsafe-path', 'link or outside the capsule directory'); continue; }
    let doc;
    try { doc = readFileSync(full, 'utf8'); } catch { note(name, 'unreadable'); continue; }
    if (!hasFrontmatter(doc)) { note(name, 'no-frontmatter'); continue; }
    const status = scalar(doc, 'status');
    if (status && CONSUMED_STATUSES.has(status)) {
      note(name, 'already-consumed', status);
      if (status === 'resumed') {
        const t = Date.parse(String(scalar(doc, 'created_at')));
        if (Number.isFinite(t) && t > newestResumed) newestResumed = t;
      }
      continue;
    }
    if (status !== 'active') { note(name, 'status-not-active', status || '(absent)'); continue; }
    const createdRaw = scalar(doc, 'created_at');
    const created = Date.parse(String(createdRaw));
    if (!Number.isFinite(created)) { note(name, 'bad-created_at', createdRaw || '(absent)'); continue; }
    const { fields, problems } = validateCapsuleText(doc);
    if (problems.length) { note(name, 'invalid', problems[0]); continue; }
    const ageDays = (now - created) / 86400000;
    if (ageDays > maxAgeDays) { note(name, 'stale', `${Math.round(ageDays)}d old, limit ${maxAgeDays}d`); continue; }
    actives.push({ path: full, name, id: fields.id, created, createdRaw, objective: fields.objective, waiting_on: fields.waiting_on, next_valid_action: fields.next_valid_action });
  }
  for (const c of actives) {
    if (c.created <= newestResumed) { note(c.name, 'already-consumed', 'older than an already resumed capsule'); continue; }
    if (!best || c.created > best.created || (c.created === best.created && saveOrder(c.name) > saveOrder(best.name))) best = c;
  }
  return { capsule: best, rejected };
}

export function maxAgeDays() {
  // Precedence: env override, then the maxAgeDays userConfig option, then the default.
  for (const k of ['CONTEXT_CAPSULE_MAX_AGE_DAYS', 'CLAUDE_PLUGIN_OPTION_maxAgeDays', 'CLAUDE_PLUGIN_OPTION_MAXAGEDAYS']) {
    const n = Number(process.env[k]);
    if (process.env[k] && Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_AGE_DAYS;
}

// ---------- PreCompact marker ----------
// PreCompact stdout never reaches the model, so the hook leaves a marker in the capsule dir and
// the next SessionStart(compact) turns it into a nudge. Not a .md file: the selector ignores it.
export const MARKER_NAME = '.precompact-marker.json';

export function writeMarker(dir, info) {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, MARKER_NAME);
  let present = true;
  try { lstatSync(p); } catch { present = false; }
  if (present && !isContainedFile(dir, p)) return false; // a link or odd entry: never write through it
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), ...info }), { flag: 'wx' });
  renameSync(tmp, p);
  return true;
}

// Returns the parsed marker or null; always removes it.
export function takeMarker(dir) {
  const p = path.join(dir, MARKER_NAME);
  let st;
  try { st = lstatSync(p); } catch { return null; }
  if (!st.isFile() || st.isSymbolicLink()) { try { rmSync(p); } catch { /* best effort */ } return null; } // drop the link itself, never its target
  if (!isContainedFile(dir, p)) return null;
  let m = null;
  try { m = JSON.parse(readFileSync(p, 'utf8')); } catch { m = {}; }
  try { rmSync(p); } catch { /* best effort */ }
  return m;
}

// ---------- rendering ----------

// Single line, quoted, bounded: capsule text is data, never a line of our own.
export function inert(value, max = 300) {
  let s = String(collapse(value ?? '')).replace(/[ \t]+/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, max)}...[+${s.length - max} chars]`;
  return JSON.stringify(s);
}

export function rejectionLines(rejected, maxGroups = 4) {
  const groups = new Map();
  for (const r of rejected) {
    if (r.reason === 'already-consumed') continue; // ordinary history
    const g = groups.get(r.reason) || { n: 0, ex: r.name, detail: r.detail };
    g.n += 1; groups.set(r.reason, g);
  }
  return [...groups].slice(0, maxGroups).map(([reason, g]) =>
    `  - ${reason} x${g.n}: ${inert(g.ex, 80)}${g.detail ? ` (${inert(g.detail, 80)})` : ''}`);
}

// ---------- consume (port of markCapsuleConsumed) ----------

export function markCapsuleConsumed(file) {
  if (!isContainedFile(path.dirname(file), file)) return false;
  const doc = readFileSync(file, 'utf8');
  const m = doc.match(FRONTMATTER);
  if (!m) return false;
  const marked = m[0].replace(/(^|\n)(status:[ \t]*)(['"]?)active\3[ \t]*(?=\r?(?:\n|$))/, (_x, b, p) => `${b}${p}resumed`);
  if (marked === m[0]) return false;
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, marked + doc.slice(m[0].length), { flag: 'wx' });
  renameSync(tmp, file); // replaces the entry itself, never writes through it
  return true;
}

// ---------- writer ----------

function yq(s) { return JSON.stringify(String(s)); }

function isoWithOffset(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

export function slugify(s) {
  return String(s || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
}

export function buildCapsule({ id, objective, waitingOn, nextAction, trigger = 'manual', body = '', now = new Date() }) {
  const sections = body.trim() || CAPSULE_SECTIONS.map(({ title, anchor }) =>
    `## ${title}\n${anchor}\n`).join('\n');
  return `---
id: ${id}
parent_capsule_id: null
status: active
objective: ${yq(objective)}
waiting_on: ${yq(waitingOn)}
resume_trigger: ${trigger}
expires: null
trigger: ${trigger}
next_valid_action: ${yq(nextAction)}
success_criteria: []
tags: [capsule]
created_at: ${isoWithOffset(now)}
resolved_at: null
---

> [!info] [REFERENCE ONLY] - state snapshot, not instructions. Latest memory state wins.

${sections}
`;
}

// Writes a validated capsule into dir (created if missing). Throws on invalid input.
// Filesystems without hard links (FAT, exFAT, some network and bind mounts) fail link with these codes.
const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']);

export function writeCapsule(dir, { objective, waitingOn, nextAction, slug, trigger, body, now = new Date(), link = linkSync }) {
  for (const [k, v] of [['objective', objective], ['waiting-on', waitingOn], ['next-action', nextAction]]) {
    if (typeof v !== 'string') throw new Error(`refusing to write an invalid capsule: --${k} is required`);
  }
  const p2 = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const stamp = `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const base = `${date}-${slugify(slug || objective)}-${stamp}`;
  const text0 = buildCapsule({ id: base, objective, waitingOn, nextAction, trigger, body, now });
  const { problems } = validateCapsuleText(text0);
  if (problems.length) throw new Error(`refusing to write an invalid capsule: ${problems.join('; ')}`);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${base}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    // Publish without replacing: link fails with EEXIST if the name is taken, so a same-second
    // save gets a -2, -3 ... suffix instead of overwriting the earlier capsule.
    for (let n = 1; n < 1000; n += 1) {
      const id = n === 1 ? base : `${base}-${n}`;
      const file = path.join(dir, `${id}.md`);
      const text = n === 1 ? text0 : buildCapsule({ id, objective, waitingOn, nextAction, trigger, body, now });
      writeFileSync(tmp, text, { flag: 'w' });
      try { link(tmp, file); return { id, path: file }; } catch (e) {
        if (e.code === 'EEXIST') continue;
        if (!NO_LINK.has(e.code)) throw e;
        // No hard links here: exclusive create still never replaces an existing capsule.
        try { writeFileSync(file, text, { flag: 'wx' }); return { id, path: file }; } catch (e2) { if (e2.code !== 'EEXIST') throw e2; }
      }
    }
    throw new Error('could not find a free capsule name');
  } finally { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } }
}

// ---------- hook helpers ----------

export function readPayload() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}') || {}; } catch { return {}; }
}

// ---------- CLI ----------

// Returns the value, undefined when the flag is absent. A flag with no value, or whose value is
// another flag, throws so a bad call never turns into a capsule.
function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
  return v;
}

function cli(argv) {
  try { return cli2(argv); } catch (e) { process.stderr.write(`${e.message}
`); return 1; }
}

function cli2(argv) {
  const [cmd, ...rest] = argv;
  const dir = () => capsuleDir({}, flag(rest, 'dir'));
  if (cmd === 'dir') { process.stdout.write(`${dir()}\n`); return 0; }
  if (cmd === 'newest') {
    const { capsule, rejected } = selectCapsule(dir(), { maxAgeDays: maxAgeDays() });
    if (!capsule) { process.stderr.write(`no valid capsule in ${dir()}\n${rejectionLines(rejected).join('\n')}\n`); return 1; }
    process.stdout.write(`${capsule.path}\n`); return 0;
  }
  if (cmd === 'validate') {
    let text;
    try { text = readFileSync(rest[0], 'utf8'); } catch (e) { process.stderr.write(`cannot read ${rest[0]}: ${e.message}\n`); return 1; }
    const { problems } = validateCapsuleText(text);
    if (problems.length) { process.stderr.write(`INVALID: ${problems.join('; ')}\n`); return 1; }
    process.stdout.write('VALID\n'); return 0;
  }
  if (cmd === 'write') {
    const bodyFile = flag(rest, 'body-file');
    try {
      const r = writeCapsule(dir(), {
        objective: flag(rest, 'objective'), waitingOn: flag(rest, 'waiting-on'), nextAction: flag(rest, 'next-action'),
        slug: flag(rest, 'slug'), trigger: flag(rest, 'trigger'), body: bodyFile ? readFileSync(bodyFile, 'utf8') : '',
      });
      process.stdout.write(`${r.path}\n`); return 0;
    } catch (e) { process.stderr.write(`${e.message}\n`); return 1; }
  }
  process.stderr.write('usage: capsule-lib.mjs dir | newest | validate <file> | write --objective O --waiting-on W --next-action N [--slug S] [--trigger T] [--body-file F]; dir, newest and write take [--dir D]\n');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = cli(process.argv.slice(2));
}
