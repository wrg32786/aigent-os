// memory-root.test.mjs -- one configured seat memory root, one resolver, one
// live tree.
//
// The defect these witnesses pin: five components each carried their own copy
// of "vault/memory, else memory", so a seat whose live memory sat at memory/
// beside a dead vault/memory/ was read from the dead tree by every component
// that preferred the default, and written into it by every hook. The fix is a
// declaration in the seat's existing install marker, .aigent/state.json, and
// one resolver every core reader and writer goes through.
//
// Every fixture layout here is invented by the test. No fleet path, seat name
// or supervisor vocabulary appears in this file or in the product.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { memRoot, selectCapsule } from '../lifecycle-common.mjs';
import { runResumeVerb } from '../resume-verb.mjs';
import { resolveNightlyPaths } from '../nightly-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMONS = path.join(__dirname, '..');
const REPO = path.join(DAEMONS, '..');
const RESOLVER = path.join(DAEMONS, 'memory-root.cjs');
const ERROR_TOKEN = 'MEMORY-ROOT:';

function capsuleDoc(id, createdAt) {
  return '---\n'
    + `id: ${id}\n`
    + 'objective: "Prove the memory root resolver"\n'
    + 'status: active\n'
    + 'waiting_on: "the witness"\n'
    + 'next_valid_action: "run the witness"\n'
    + `created_at: ${createdAt}\n`
    + '---\n\n# Fixture capsule body\n';
}

// A root with any layout the test asks for. `declare` is the memory_root value
// to write into .aigent/state.json, or undefined to declare nothing (stock),
// or a raw string to write the marker verbatim (malformed cases).
function mkRoot({ dirs = [], capsules = {}, declare, rawMarker } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'memory-root-'));
  const root = path.join(base, 'seat');
  mkdirSync(root, { recursive: true });
  for (const dir of dirs) mkdirSync(path.join(root, ...dir.split('/')), { recursive: true });
  for (const [rel, doc] of Object.entries(capsules)) {
    const file = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, doc);
  }
  if (rawMarker !== undefined || declare !== undefined) {
    mkdirSync(path.join(root, '.aigent'), { recursive: true });
    const text = rawMarker !== undefined
      ? rawMarker
      : JSON.stringify({ schemaVersion: 1, status: 'ready', completedAt: null, memory_root: declare }, null, 2);
    writeFileSync(path.join(root, '.aigent', 'state.json'), text);
  }
  return { base, root };
}

// A content snapshot of a tree: relative path -> sha256. Used to prove a dead
// tree is never touched, and to enumerate what a hook drive created.
function snapshot(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(path.relative(dir, full).split(path.sep).join('/'), createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try { return fn(); } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const NO_DIVERSION = { AIGENT_STATE_HOME_DIR: undefined };

// ── W1: a live memory/ beside a dead vault/memory/ ───────────────────────────

test('W1: a seat that declares memory_root "memory" resolves there even though a dead vault/memory exists', () => {
  const fx = mkRoot({
    dirs: ['vault/memory/capsules', 'memory/capsules'],
    capsules: {
      'vault/memory/capsules/2026-01-01-dead.md': capsuleDoc('2026-01-01-dead', '2026-01-01T00:00:00.000Z'),
      'memory/capsules/2026-06-01-live.md': capsuleDoc('2026-06-01-live', '2026-06-01T00:00:00.000Z'),
    },
    declare: 'memory',
  });
  try {
    withEnv(NO_DIVERSION, () => {
      assert.equal(memRoot(fx.root), path.join(fx.root, 'memory'),
        'the declared root wins over the default tree that happens to exist');
      const { capsule } = selectCapsule(memRoot(fx.root));
      assert.equal(capsule?.id, '2026-06-01-live', 'capsule selection reads the live tree');
      const dead = snapshot(path.join(fx.root, 'vault', 'memory'));
      const result = runResumeVerb({ projectRoot: fx.root, source: 'clear', sessionId: 'sid-1' });
      assert.equal(result.loaded?.id, '2026-06-01-live', 'resume loads the live capsule');
      assert.deepEqual(snapshot(path.join(fx.root, 'vault', 'memory')), dead,
        'the dead default tree is neither read for state nor written');
      const nightly = resolveNightlyPaths(fx.root, { stateHome: fx.root, env: {} });
      assert.equal(nightly.memoryRoot, path.join(fx.root, 'memory'), 'the nightly pass agrees');
      assert.equal(nightly.layout, 'memory');
    });
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

// ── W2: a nested layout ──────────────────────────────────────────────────────

test('W2: a seat that declares a nested memory_root resolves there with no default tree present', () => {
  const fx = mkRoot({
    dirs: ['.nested/vault/memory/capsules'],
    capsules: {
      '.nested/vault/memory/capsules/2026-06-02-nested.md': capsuleDoc('2026-06-02-nested', '2026-06-02T00:00:00.000Z'),
    },
    declare: '.nested/vault/memory',
  });
  try {
    withEnv(NO_DIVERSION, () => {
      assert.equal(memRoot(fx.root), path.join(fx.root, '.nested', 'vault', 'memory'));
      const result = runResumeVerb({ projectRoot: fx.root, source: 'clear', sessionId: 'sid-1' });
      assert.equal(result.loaded?.id, '2026-06-02-nested');
      assert.ok(!existsSync(path.join(fx.root, 'vault')), 'no default tree was created beside the declared one');
      assert.ok(!existsSync(path.join(fx.root, 'memory')), 'no legacy tree was created beside the declared one');
      const nightly = resolveNightlyPaths(fx.root, { stateHome: fx.root, env: {} });
      assert.equal(nightly.memoryRoot, path.join(fx.root, '.nested', 'vault', 'memory'));
    });
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

// ── W3: stock stays stock ────────────────────────────────────────────────────

test('W3: an install that declares nothing keeps the documented default and the pre-existing fallback order', () => {
  const stock = mkRoot({ dirs: ['vault/memory'] });
  const legacy = mkRoot({ dirs: ['memory'] });
  const bare = mkRoot({});
  const marker = mkRoot({ dirs: ['vault/memory'], rawMarker: '{"schemaVersion":1,"status":"ready","completedAt":null}\n' });
  try {
    withEnv(NO_DIVERSION, () => {
      assert.equal(memRoot(stock.root), path.join(stock.root, 'vault', 'memory'));
      assert.equal(memRoot(legacy.root), path.join(legacy.root, 'memory'), 'an undeclared root with only memory/ keeps resolving there');
      assert.equal(memRoot(bare.root), path.join(bare.root, 'vault', 'memory'), 'nothing on disk resolves to the default');
      assert.equal(memRoot(marker.root), path.join(marker.root, 'vault', 'memory'), 'a stock install marker declares nothing');
      const nightly = resolveNightlyPaths(stock.root, { stateHome: stock.root, env: {} });
      assert.equal(nightly.layout, 'vault/memory');
    });
  } finally {
    for (const fx of [stock, legacy, bare, marker]) rmSync(fx.base, { recursive: true, force: true });
  }
});

test('W3: the AIGENT_STATE_HOME_DIR diversion reads the declaration under the diverted base, not the real root', () => {
  const real = mkRoot({ dirs: ['memory'], declare: 'memory' });
  const divert = mkRoot({ dirs: ['vault/memory'] });
  try {
    withEnv({ AIGENT_STATE_HOME_DIR: divert.root }, () => {
      assert.equal(memRoot(real.root), path.join(divert.root, 'vault', 'memory'),
        'a diverted hook must never touch the real seat, declared or not');
    });
  } finally {
    rmSync(real.base, { recursive: true, force: true });
    rmSync(divert.base, { recursive: true, force: true });
  }
});

// ── W4: malformed, missing or unsafe configuration fails loudly ──────────────

test('W4: every malformed, missing or unsafe declaration throws the named error and touches no tree', () => {
  const cases = [
    ['invalid JSON', { rawMarker: '{"schemaVersion":1,' }, /is not valid JSON/],
    ['root is an array', { rawMarker: '[]' }, /root must be an object/],
    ['not a string', { rawMarker: '{"schemaVersion":1,"memory_root":123}' }, /must be a string/],
    ['empty', { declare: '' }, /must not be empty/],
    ['absolute posix', { declare: '/srv/memory' }, /not absolute/],
    ['absolute windows', { declare: 'C:/srv/memory' }, /not absolute/],
    ['escapes the root', { declare: 'sibling/../../memory' }, /\.\. segment/],
    ['backslashes', { declare: 'vault\\memory' }, /forward slashes/],
    ['dot segment', { declare: './memory' }, /empty or \. path segment/],
    ['control character', { declare: 'mem\u0007ory' }, /control characters/],
    ['declared but missing on disk', { declare: 'elsewhere/memory', dirs: ['vault/memory'] }, /does not exist/],
    ['declared but a file', { declare: 'memory', capsules: { memory: 'not a directory' } }, /not a directory/],
  ];
  for (const [label, layout, reason] of cases) {
    const fx = mkRoot(layout);
    try {
      withEnv(NO_DIVERSION, () => {
        const before = readdirSync(fx.root).sort();
        assert.throws(() => memRoot(fx.root), (error) => {
          assert.equal(error.name, 'MemoryRootError', `${label}: must throw the typed error`);
          assert.ok(error.message.startsWith(ERROR_TOKEN), `${label}: the message must carry the greppable token`);
          assert.match(error.message, reason, `${label}: the reason must be named`);
          return true;
        }, `${label}: a bad declaration must never resolve to any tree`);
        assert.deepEqual(readdirSync(fx.root).sort(), before, `${label}: nothing may be created while refusing`);
        const cli = spawnSync(process.execPath, [RESOLVER, '--root', fx.root], { encoding: 'utf8' });
        assert.equal(cli.status, 1, `${label}: the CLI exits 1`);
        assert.equal(cli.stdout, '', `${label}: the CLI prints no path`);
        assert.ok(cli.stderr.startsWith(ERROR_TOKEN), `${label}: the CLI names the fault under the token, got ${JSON.stringify(cli.stderr)}`);
      });
    } finally {
      rmSync(fx.base, { recursive: true, force: true });
    }
  }
});

test('W4: a declared root through a symlink is refused', async () => {
  const { symlinkSync } = await import('node:fs');
  const fx = mkRoot({ dirs: ['real-memory'], declare: 'linked/memory' });
  try {
    // A junction on Windows needs no privilege and is a symlink to lstat.
    symlinkSync(path.join(fx.root, 'real-memory'), path.join(fx.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    withEnv(NO_DIVERSION, () => {
      assert.throws(() => memRoot(fx.root), /passes through a symlink/);
    });
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('W4: the resume verb reports a broken memory root in the procedure instead of reading a default tree', () => {
  const fx = mkRoot({ dirs: ['vault/memory/capsules'], declare: 'gone/memory' });
  try {
    withEnv(NO_DIVERSION, () => {
      const result = runResumeVerb({ projectRoot: fx.root, source: 'clear', sessionId: 'sid-1' });
      assert.equal(result.degraded, true);
      assert.ok(result.prompt.includes(ERROR_TOKEN), 'the seat must see the fault in its own procedure');
      assert.match(String(result.memoryRootError), /does not exist/);
      assert.ok(!existsSync(path.join(fx.root, 'gone')), 'the refused root was not created');
    });
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

// ── W5a: no core file constructs a memory path outside the resolver ──────────
//
// Structural, comment-stripped: the rule is enforced on code, and a comment
// describing the old rule is not a violation. A mutation that hard-codes the
// default in any hook, script or daemon goes red here before it goes red in
// the behavioral witness below.

const SCAN_FILES = [
  ...listFiles(path.join(REPO, 'daemons'), (name) => /\.(mjs|cjs|js|sh|py)$/.test(name), { skip: ['tests', 'transport-deps', 'node_modules', 'templates'] }),
  ...listFiles(path.join(REPO, 'scripts'), (name) => /\.(sh|mjs|py)$/.test(name)),
  ...listFiles(path.join(REPO, 'hooks'), (name) => /\.sh$/.test(name)),
  path.join(REPO, 'install.sh'),
  path.join(REPO, 'launcher', 'install.sh'),
  path.join(REPO, 'launcher', 'install.ps1'),
].filter((file) => existsSync(file) && !['memory-root.cjs', 'memory-root.sh', 'memory_root.py'].includes(path.basename(file)));

// ── the shell door: delegates to the resolver, and its no-node default IS the resolver's ──

const DOOR = path.join(DAEMONS, 'memory-root.sh');

function door(base, extra = [], env = process.env) {
  return spawnSync('bash', ['-c', `. "${DOOR.replace(/\\/g, '/')}" && aigent_memory_root "$@"`, 'door', base, ...extra], { encoding: 'utf8', env });
}

test('door: with node present every answer is the resolver\'s own, refusals included', () => {
  const declared = mkRoot({ dirs: ['memory'], declare: 'memory' });
  const broken = mkRoot({ declare: '../x' });
  const stock = mkRoot({ dirs: ['vault/memory'] });
  try {
    for (const [fx, extra] of [[declared, []], [declared, ['--relative']], [stock, ['--relative']], [broken, []]]) {
      const shell = door(fx.root, extra);
      const node = spawnSync(process.execPath, [RESOLVER, '--root', fx.root, ...extra], { encoding: 'utf8' });
      assert.equal(shell.status, node.status, `${fx.root} ${extra}: exit codes must agree`);
      assert.equal(shell.stdout, node.stdout, `${fx.root} ${extra}: stdout must be the resolver's`);
      assert.equal(shell.stderr, node.stderr, `${fx.root} ${extra}: stderr must be the resolver's`);
    }
  } finally {
    for (const fx of [declared, broken, stock]) rmSync(fx.base, { recursive: true, force: true });
  }
});

test('door: with node absent, an undeclared root gets exactly the resolver\'s default rule and a declared one is refused', () => {
  // PATH pruned of every directory that holds node, the way the capture
  // hook's own "scan down" test does it.
  const pruned = (process.env.PATH || '').split(path.delimiter)
    .filter((dir) => dir && !existsSync(path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node')))
    .join(path.delimiter);
  const env = { ...process.env, PATH: pruned };
  const probe = spawnSync('bash', ['-c', 'command -v node || echo ABSENT'], { encoding: 'utf8', env });
  assert.match(probe.stdout, /ABSENT/, 'node must really be absent for this witness');
  const cases = [
    [mkRoot({ dirs: ['vault/memory'] }), 'vault/memory'],
    [mkRoot({ dirs: ['memory'] }), 'memory'],
    [mkRoot({ dirs: ['vault/memory', 'memory'] }), 'vault/memory'],
    [mkRoot({}), 'vault/memory'],
    [mkRoot({ dirs: ['vault/memory'], rawMarker: '{"schemaVersion":1}' }), 'vault/memory'],
  ];
  try {
    for (const [fx, expected] of cases) {
      const shell = door(fx.root, ['--relative'], env);
      assert.equal(shell.status, 0, shell.stderr);
      assert.equal(shell.stdout.trim(), expected, `no-node default must match the resolver's rule for ${JSON.stringify(readdirSync(fx.root))}`);
      // Same fixture, the resolver itself (node back on PATH): same answer.
      const node = spawnSync(process.execPath, [RESOLVER, '--root', fx.root, '--relative'], { encoding: 'utf8' });
      assert.equal(node.stdout.trim(), expected);
    }
    const declared = mkRoot({ dirs: ['memory'], declare: 'memory' });
    try {
      const refused = door(declared.root, [], env);
      assert.equal(refused.status, 1, 'a declaration with no resolver available must refuse');
      assert.equal(refused.stdout, '');
      assert.match(refused.stderr, /^MEMORY-ROOT: .*declares memory_root but node is not available/);
    } finally {
      rmSync(declared.base, { recursive: true, force: true });
    }
  } finally {
    for (const [fx] of cases) rmSync(fx.base, { recursive: true, force: true });
  }
});

function listFiles(dir, accept, { skip = [] } = {}) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (accept(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// Comment lines are blanked, never removed, so line numbers stay aligned with
// the raw file (the exemption markers are looked up by line).
function stripComments(file, text) {
  if (/\.(sh|py|ps1)$/.test(file)) {
    return text.split('\n').map((line) => (/^\s*#/.test(line) ? '' : line)).join('\n');
  }
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line.replace(/(^|[^:'"`])\/\/.*$/, '$1')))
    .join('\n');
}

// What counts as constructing a memory root by hand: the default tree spelled
// out, a join that appends a bare "memory" segment, or a shell path that
// appends /memory to a root variable. "memory-" prefixes (memory-heat,
// memory-hygiene, memory-candidates-guard) are module names, not trees.
const ROOT_LITERALS = [
  /vault\/memory/,
  /['"]vault['"]\s*,\s*['"]memory['"]/,
  /join\([^)\n]*['"]memory['"]\s*[,)]/,
  /\$[A-Za-z_{}]+\/memory(\/|["'\s]|$)/,
  // Python: Path(...) / "memory", ... / "vault" / "memory", os.path.join(..., "memory")
  /\/\s*["']memory["']/,
  /["']vault["']\s*\/\s*["']memory["']/,
];

// The shell consumers keep ONE literal each for the case where node is
// absent and nothing can resolve (the installer's --no-deps path, doctor and
// the launcher on a box without node). Each such line is marked, and the
// marker is only honored inside the else-branch of a guard that first checks
// for a declaration, so a declared root can never be silently defaulted.
const EXEMPT_MARKER = /# memory-root: (no-node default|source template, not a memory tree)\s*$/;

function exemptionHolds(lines, index) {
  // A source-template read ($SRC/memory/..., the repo's public seed files) is
  // exempt on the marked line and its continuation lines directly below it.
  if (/\$SRC\/(\$dir\/)?memory(\/|"|\s)/.test(lines[index])) {
    return lines.slice(Math.max(0, index - 2), index + 1).some((line) => /# memory-root: source template, not a memory tree\s*$/.test(line));
  }
  const marker = lines[index].match(EXEMPT_MARKER);
  if (!marker || !marker[1].startsWith('no-node')) return false;
  // The guard: a declaration was looked for (bash grep or PowerShell
  // Select-String) and this line sits in the else-branch that follows.
  const window = lines.slice(Math.max(0, index - 6), index).join('\n');
  return /'"memory_root"'/.test(window) && /^\s*(else\s*|\} else \{\s*)$/m.test(window);
}

test('W5a: no core reader or writer constructs the memory root by hand', () => {
  const offenders = [];
  const exemptions = [];
  for (const file of SCAN_FILES) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    const rawLines = readFileSync(file, 'utf8').split('\n');
    const lines = stripComments(file, rawLines.join('\n')).split('\n');
    lines.forEach((line, index) => {
      if (!ROOT_LITERALS.some((re) => re.test(line))) return;
      if (exemptionHolds(rawLines, index)) { exemptions.push(`${rel}:${index + 1}`); return; }
      offenders.push(`${rel}:${index + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.ok(SCAN_FILES.length > 20, `the scan must cover the core, saw ${SCAN_FILES.length} files`);
  assert.deepEqual(offenders, [], `memory paths must go through daemons/memory-root.cjs:\n${offenders.join('\n')}`);
  // The exemptions are a short, known list: the installer's reads of the
  // repo's own seed templates (its memory/ runtime seeds, two lines, and the
  // vault/memory doctrine seeds it routes into a declared root, one line),
  // and the PowerShell launcher's no-node default, which has no shell door to
  // source. Every bash consumer asks the door. Anything beyond that is a new
  // hand-built path, not an exemption.
  const byFile = exemptions.reduce((acc, entry) => {
    const file = entry.split(':')[0];
    acc[file] = (acc[file] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(byFile, { 'install.sh': 4, 'launcher/install.ps1': 1, 'launcher/install.sh': 1 },
    `the exemption list is fixed, saw ${exemptions.join(', ')}`);
});

// ── W5b: the real hooks, driven, write only into the declared tree ───────────

test('W5b: driven against a declared root, every hook writes into it and the dead default tree stays byte-identical', () => {
  const fx = mkRoot({
    dirs: ['vault/memory/capsules', 'vault/memory/runtime', 'memory/capsules'],
    capsules: {
      'vault/memory/capsules/2026-01-01-dead.md': capsuleDoc('2026-01-01-dead', '2026-01-01T00:00:00.000Z'),
      'memory/capsules/2026-06-01-live.md': capsuleDoc('2026-06-01-live', '2026-06-01T00:00:00.000Z'),
    },
    declare: 'memory',
  });
  try {
    const dead = snapshot(path.join(fx.root, 'vault', 'memory'));
    const liveBefore = snapshot(path.join(fx.root, 'memory'));
    const env = {
      ...process.env,
      AIGENT_ROOT: fx.root,
      CLAUDE_PROJECT_DIR: fx.root,
      AIGENT_STATE_HOME_DIR: fx.root,
      AIGENT_SEAT_ID: 'witness',
      AUTO_CLEAR_OFF: '1',
    };
    const drive = (script, payload) => spawnSync(process.execPath, [path.join(DAEMONS, script)], {
      input: JSON.stringify(payload), env, encoding: 'utf8', cwd: fx.root,
    });
    const runs = [
      ['userpromptsubmit-journal.mjs', { session_id: 'sid-w5', prompt: 'hello from the witness', cwd: fx.root }],
      ['sessionstart-reinject.mjs', { session_id: 'sid-w5', source: 'startup', cwd: fx.root }],
      ['sessionend-flush.mjs', { session_id: 'sid-w5', reason: 'other', cwd: fx.root }],
      ['gateguard.mjs', { session_id: 'sid-w5', tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: fx.root }],
      ['precompact-flush.mjs', { session_id: 'sid-w5', trigger: 'manual', cwd: fx.root }],
    ];
    for (const [script, payload] of runs) {
      const r = drive(script, payload);
      assert.ok(r.status === 0 || r.status === null, `${script}: exit ${r.status}\n${r.stderr}`);
    }
    assert.deepEqual(snapshot(path.join(fx.root, 'vault', 'memory')), dead, 'the dead tree must be byte-identical after the drive');
    const liveAfter = snapshot(path.join(fx.root, 'memory'));
    const created = [...liveAfter.keys()].filter((key) => !liveBefore.has(key));
    assert.ok(created.some((key) => key.startsWith('runtime/')), `the hooks must have written runtime state into the declared tree, saw ${JSON.stringify(created)}`);
    const strays = readdirSync(fx.root).filter((name) => !['.aigent', 'vault', 'memory'].includes(name));
    assert.deepEqual(strays, [], 'no third tree may appear at the root');
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

// ── the skill ledgers: one tree when declared, the stock seed tree otherwise ──

test('ledgers: a declared seat keeps its skill ledgers in the one tree; a stock install keeps them in its memory/ seed tree', () => {
  const declared = mkRoot({ dirs: ['memory', 'vault/memory'], declare: 'memory' });
  const stock = mkRoot({ dirs: ['vault/memory', 'memory'] });
  const stockNoSeed = mkRoot({ dirs: ['vault/memory'] });
  try {
    const ask = (fx, extra = []) => spawnSync(process.execPath, [RESOLVER, '--root', fx.root, '--ledgers', ...extra], { encoding: 'utf8' });
    assert.equal(ask(declared).stdout.trim(), path.join(declared.root, 'memory'), 'declared: the ledgers are in the one tree');
    assert.equal(ask(stock, ['--relative']).stdout.trim(), 'memory', 'stock: the ledgers are where the seed tree ships them');
    assert.equal(ask(stockNoSeed, ['--relative']).stdout.trim(), 'vault/memory', 'no seed tree: the ledgers fall to the memory root');
    // The shell door agrees, with and without node.
    const pruned = (process.env.PATH || '').split(path.delimiter)
      .filter((dir) => dir && !existsSync(path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node')))
      .join(path.delimiter);
    for (const env of [process.env, { ...process.env, PATH: pruned }]) {
      assert.equal(door(stock.root, ['--ledgers', '--relative'], env).stdout.trim(), 'memory');
      assert.equal(door(stockNoSeed.root, ['--ledgers', '--relative'], env).stdout.trim(), 'vault/memory');
    }
    assert.equal(door(declared.root, ['--ledgers']).stdout.trim(), path.join(declared.root, 'memory'));
    // One spawn, both answers: --with-ledgers is the two single answers on two
    // lines, from the resolver and from the door with and without node.
    for (const fx of [declared, stock, stockNoSeed]) {
      const both = spawnSync(process.execPath, [RESOLVER, '--root', fx.root, '--with-ledgers', '--relative'], { encoding: 'utf8' });
      const expected = `${spawnSync(process.execPath, [RESOLVER, '--root', fx.root, '--relative'], { encoding: 'utf8' }).stdout.trim()}\n${ask(fx, ['--relative']).stdout.trim()}`;
      assert.equal(both.stdout.trim(), expected, 'the resolver pairs the two answers');
      for (const env of [process.env, { ...process.env, PATH: pruned }]) {
        if (fx === declared && env.PATH === pruned) continue; // no node: a declaration refuses, as pinned elsewhere
        assert.equal(door(fx.root, ['--with-ledgers', '--relative'], env).stdout.trim(), expected, 'the door pairs the same two answers');
      }
    }
  } finally {
    for (const fx of [declared, stock, stockNoSeed]) rmSync(fx.base, { recursive: true, force: true });
  }
});

// ── the resolver CLI, which every shell consumer calls ───────────────────────

test('CLI: prints the resolved root, honors --relative and --allow-missing, refuses a malformed invocation', () => {
  const fx = mkRoot({ declare: 'seat-memory' });
  try {
    const strict = spawnSync(process.execPath, [RESOLVER, '--root', fx.root], { encoding: 'utf8' });
    assert.equal(strict.status, 1, 'a declared root that is missing is refused at runtime');
    assert.match(strict.stderr, /does not exist/);
    const lenient = spawnSync(process.execPath, [RESOLVER, '--root', fx.root, '--allow-missing', '--relative'], { encoding: 'utf8' });
    assert.equal(lenient.status, 0, lenient.stderr);
    assert.equal(lenient.stdout.trim(), 'seat-memory', 'the installer resolves in order to create');
    mkdirSync(path.join(fx.root, 'seat-memory'));
    const ok = spawnSync(process.execPath, [RESOLVER, '--root', fx.root], { encoding: 'utf8' });
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout.trim(), path.join(fx.root, 'seat-memory'));
    assert.ok(statSync(ok.stdout.trim()).isDirectory());
    for (const args of [['--root'], ['--rot', fx.root], ['--root', fx.root, 'stray'], ['--root', fx.root, '--root', fx.root], []]) {
      const bad = spawnSync(process.execPath, [RESOLVER, ...args], { encoding: 'utf8' });
      assert.equal(bad.status, 1, `${JSON.stringify(args)} must refuse`);
      assert.equal(bad.stdout, '');
      assert.ok(bad.stderr.startsWith(ERROR_TOKEN), `${JSON.stringify(args)}: ${bad.stderr}`);
    }
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

// ── the Python daemons go through the same door ──────────────────────────────

const PYTHON = ['python3', 'python'].find((bin) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0);

test('W5c: the Python state daemon reads and writes the declared tree and leaves the dead default tree alone', { skip: !PYTHON && 'python not available' }, () => {
  const live = mkRoot({
    dirs: ['vault/memory/runtime', 'memory/runtime', 'memory/capsules'],
    declare: 'memory',
  });
  const nested = mkRoot({ dirs: ['.nested/vault/memory'], declare: '.nested/vault/memory' });
  const broken = mkRoot({ dirs: ['vault/memory'], declare: 'gone/memory' });
  try {
    writeFileSync(path.join(live.root, 'vault', 'memory', 'BODY_STATE.json'), JSON.stringify({ state: { pressure: 'critical' } }));
    writeFileSync(path.join(live.root, 'memory', 'BODY_STATE.json'), JSON.stringify({ state: { pressure: 'low' } }));
    const dead = snapshot(path.join(live.root, 'vault', 'memory'));
    const daemon = path.join(DAEMONS, 'runtime', 'update-active-state.py');
    const run = (root) => spawnSync(PYTHON, [daemon], { encoding: 'utf8', env: { ...process.env, AIGENT_ROOT: root, AIGENT_VAULT: root, AIGENT_STATE_HOME_DIR: root } });
    const r1 = run(live.root);
    assert.equal(r1.status, 0, r1.stderr);
    assert.ok(existsSync(path.join(live.root, 'memory', 'runtime', 'ACTIVE_STATE.json')), 'state is written into the declared tree');
    assert.deepEqual(snapshot(path.join(live.root, 'vault', 'memory')), dead, 'the dead default tree is untouched');
    const r2 = run(nested.root);
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(existsSync(path.join(nested.root, '.nested', 'vault', 'memory', 'runtime', 'ACTIVE_STATE.json')));
    assert.ok(!existsSync(path.join(nested.root, 'vault')), 'no default tree is created beside a nested declared root');
    const r3 = run(broken.root);
    assert.notEqual(r3.status, 0, 'a broken declaration must stop the daemon');
    assert.match(r3.stderr, /MEMORY-ROOT: /);
    assert.ok(!existsSync(path.join(broken.root, 'vault', 'memory', 'runtime')), 'nothing is written around a broken declaration');
  } finally {
    for (const fx of [live, nested, broken]) rmSync(fx.base, { recursive: true, force: true });
  }
});

test('W5c: a declared root whose last segment is not "memory", and a seat directory named "vault", both keep their declaration', { skip: !PYTHON && 'python not available' }, () => {
  // Two shapes that lost the declaration once: a vault handed back into the
  // resolver (whose parent "state" declares nothing) and an AIGENT_VAULT that
  // is the install root but happens to be named vault.
  const odd = mkRoot({ dirs: ['state/mem'], declare: 'state/mem' });
  const base = mkdtempSync(path.join(tmpdir(), 'memory-root-'));
  const named = path.join(base, 'vault');
  mkdirSync(path.join(named, '.aigent'), { recursive: true });
  mkdirSync(path.join(named, 'brain'), { recursive: true });
  writeFileSync(path.join(named, '.aigent', 'state.json'), JSON.stringify({ schemaVersion: 1, memory_root: 'brain' }));
  try {
    const daemon = path.join(DAEMONS, 'runtime', 'update-active-state.py');
    const r1 = spawnSync(PYTHON, [daemon], { encoding: 'utf8', env: { ...process.env, AIGENT_ROOT: odd.root, AIGENT_VAULT: odd.root, AIGENT_STATE_HOME_DIR: odd.root } });
    assert.equal(r1.status, 0, r1.stderr);
    assert.ok(existsSync(path.join(odd.root, 'state', 'mem', 'runtime', 'ACTIVE_STATE.json')), 'state lands in the declared tree');
    assert.ok(!existsSync(path.join(odd.root, 'state', 'vault')), 'no default tree grows under the declared root\'s parent');
    assert.ok(!existsSync(path.join(odd.root, 'vault')), 'no default tree grows at the seat');
    const r2 = spawnSync(PYTHON, [daemon], { encoding: 'utf8', env: { ...process.env, AIGENT_VAULT: named, AIGENT_ROOT: undefined, AIGENT_STATE_HOME_DIR: undefined } });
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(existsSync(path.join(named, 'brain', 'runtime', 'ACTIVE_STATE.json')), 'a seat directory named vault keeps its declaration');
    assert.ok(!existsSync(path.join(named, 'memory')) && !existsSync(path.join(base, 'memory')), 'nothing resolves to a parent or a default');
  } finally {
    rmSync(odd.base, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

test('W5d: the Python door returns the declared root byte for byte through node, for a non-ASCII root and one with an apostrophe', { skip: !PYTHON && 'python not available' }, () => {
  const bases = [];
  try {
    for (const name of ['sèat-ü', "seat's root"]) {
      const base = mkdtempSync(path.join(tmpdir(), 'memory-root-'));
      bases.push(base);
      const root = path.join(base, name);
      mkdirSync(path.join(root, '.aigent'), { recursive: true });
      mkdirSync(path.join(root, 'mine'), { recursive: true });
      writeFileSync(path.join(root, '.aigent', 'state.json'), JSON.stringify({ schemaVersion: 1, memory_root: 'mine' }));
      const r = spawnSync(PYTHON, ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); from memory_root import resolve_memory_root; print(resolve_memory_root(sys.argv[2]))', DAEMONS, root], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), path.join(root, 'mine'), `${name}: the door must hand back the declared root, not a re-decoded one`);
      assert.ok(existsSync(r.stdout.trim()), `${name}: the returned path must exist`);
    }
  } finally {
    for (const base of bases) rmSync(base, { recursive: true, force: true });
  }
});
