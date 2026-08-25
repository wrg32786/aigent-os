// fleet-baseline-attest.test.mjs -- scripts/doctor.sh --attest against the
// shipped fleet baseline manifest.
//
// Every case materializes a throwaway install from the COMMITTED manifest
// (scripts/fleet-baseline-manifest.json) and points --attest at it, so this
// file validates the manifest that ships, not a synthetic one built to agree
// with itself. That is what makes the mutation witness real: change one
// expected hash in the committed manifest and the exact-install case below
// goes red, because the file copied out of the repo no longer matches what
// the manifest claims it should be.
//
// Nothing here touches a real install. Each case builds its own temp
// directory and removes it again, and --attest never writes at all -- the
// read-only case proves that by digesting the tree before and after.
//
// node-pty is stubbed rather than installed. The attestation's runner check is
// install.sh's own probe, createRequire(transport-deps/package.json)('node-pty'),
// which asks one question: does the module resolve and load. A resolvable stub
// answers it deterministically on every machine with no network and no native
// build, and the "unavailable" case removes the stub to prove the other side.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');
const DOCTOR = path.join(REPO, 'scripts', 'doctor.sh');
const MANIFEST = path.join(REPO, 'scripts', 'fleet-baseline-manifest.json');

const TERMINALS = ['COMPLIANT', 'DEGRADED', 'NONCOMPLIANT', 'UNKNOWN'];

function readManifest() {
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

// Simulates an exact install: every path the manifest requires, the manifest
// itself (the installer's COPY_DIRS already carries scripts/), a rendered
// settings.json, and the directories a real install creates.
function buildInstall({ settingsRootFor = (root) => root } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'fleet-baseline-attest-')));
  const manifest = readManifest();

  for (const relative of Object.keys(manifest.required_files)) {
    const destination = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(REPO, ...relative.split('/')), destination);
  }

  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  cpSync(MANIFEST, path.join(root, 'scripts', 'fleet-baseline-manifest.json'));

  // What install.sh's render step produces. It is deliberately not a text
  // substitution: the template is parsed as JSON, the placeholder is replaced
  // inside string values with a shell-escaped root, and the result is
  // re-serialized. A plain search-and-replace here would emit invalid JSON the
  // moment the install root contains a backslash, which every Windows install
  // root does -- so the fixture has to render the way the installer renders.
  const token = manifest.required_settings.unresolved_placeholder;
  const settingsRoot = settingsRootFor(root);
  const shellDoubleQuoted = (value) => value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
  const render = (value) => {
    if (typeof value === 'string') {
      if (!value.includes(token)) return value;
      return value === token
        ? settingsRoot
        : value.split(token).join(shellDoubleQuoted(settingsRoot));
    }
    if (Array.isArray(value)) return value.map(render);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item)]));
    }
    return value;
  };
  const template = JSON.parse(readFileSync(
    path.join(root, ...manifest.required_settings.template.split('/')),
    'utf8',
  ));
  writeFileSync(
    path.join(root, ...manifest.required_settings.path.split('/')),
    `${JSON.stringify(render(template), null, 2)}\n`,
  );

  mkdirSync(path.join(root, 'vault', 'memory', 'runtime'), { recursive: true });
  mkdirSync(
    path.join(root, ...manifest.optional_components.semantic_search.path.split('/')),
    { recursive: true },
  );

  const ptyDir = path.join(
    root,
    ...manifest.managed_runner.dependency_root.split('/'),
    'node_modules',
    'node-pty',
  );
  mkdirSync(ptyDir, { recursive: true });
  writeFileSync(
    path.join(ptyDir, 'package.json'),
    `{"name":"node-pty","version":"${manifest.managed_runner.version}","main":"index.js"}\n`,
  );
  writeFileSync(path.join(ptyDir, 'index.js'), 'module.exports = {};\n');

  return root;
}

function attest(root) {
  const result = spawnSync('bash', [DOCTOR, root, '--attest'], { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const verdicts = output
    .split('\n')
    .map((line) => line.trim().match(/^ATTEST: (\w+)$/))
    .filter(Boolean)
    .map((match) => match[1]);
  // The contract is one terminal class, not "a terminal class somewhere in the
  // output". A second verdict line would make every assertion below ambiguous.
  assert.equal(verdicts.length, 1, `expected exactly one ATTEST line, got:\n${output}`);
  assert.ok(TERMINALS.includes(verdicts[0]), `unknown terminal class: ${verdicts[0]}`);
  return { verdict: verdicts[0], status: result.status, output };
}

function digest(root) {
  const accumulator = createHash('sha256');
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) {
        walk(full, relative);
      } else {
        accumulator.update(relative);
        accumulator.update(readFileSync(full));
      }
    }
  };
  walk(root, '');
  return accumulator.digest('hex');
}

function withInstall(run, options) {
  const root = buildInstall(options);
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function lowercaseMsysRoot(root) {
  const forward = root.replace(/\\/g, '/');
  const match = forward.match(/^([A-Za-z]):(\/.*)$/);
  assert.ok(match, `expected a Windows drive path, got: ${root}`);
  return `/${match[1].toLowerCase()}${match[2].toLowerCase()}`;
}

test('an exact install attests COMPLIANT against the shipped manifest', () => {
  withInstall((root) => {
    const { verdict, status, output } = attest(root);
    assert.equal(verdict, 'COMPLIANT', output);
    assert.equal(status, 0, 'COMPLIANT exits 0');
  });
});

test('a settings fixture rendered with a lowercase Windows root attests COMPLIANT', {
  skip: process.platform !== 'win32' && 'Windows drive-letter canonicalization only',
}, () => {
  withInstall((root) => {
    const lowerRoot = lowercaseMsysRoot(root);
    const { verdict, status, output } = attest(lowerRoot);
    assert.equal(verdict, 'COMPLIANT', output);
    assert.equal(status, 0, 'COMPLIANT exits 0');
  }, { settingsRootFor: lowercaseMsysRoot });
});

// THE MUTATION WITNESS. One expected hash in the manifest is flipped; the file
// on disk is untouched. If the exact-install comparison were not actually
// comparing bytes against these hashes, this would still read COMPLIANT.
test('mutating one expected hash turns the exact-install check red', () => {
  withInstall((root) => {
    const installed = path.join(root, 'scripts', 'fleet-baseline-manifest.json');
    const manifest = JSON.parse(readFileSync(installed, 'utf8'));
    const [target] = Object.keys(manifest.required_files);
    manifest.required_files[target] = 'f'.repeat(64);
    writeFileSync(installed, `${JSON.stringify(manifest, null, 2)}\n`);

    const { verdict, status, output } = attest(root);
    assert.equal(verdict, 'NONCOMPLIANT', output);
    assert.equal(status, 1, 'NONCOMPLIANT exits 1');
    assert.match(output, new RegExp(`required file changed: ${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
});

test('a byte changed in a required file attests NONCOMPLIANT', () => {
  withInstall((root) => {
    const manifest = readManifest();
    const [target] = Object.keys(manifest.required_files);
    const file = path.join(root, ...target.split('/'));
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n`);

    const { verdict, output } = attest(root);
    assert.equal(verdict, 'NONCOMPLIANT', output);
  });
});

test('settings stale against the manifest attest NONCOMPLIANT', () => {
  withInstall((root) => {
    const manifest = readManifest();
    const settings = path.join(root, ...manifest.required_settings.path.split('/'));
    const parsed = JSON.parse(readFileSync(settings, 'utf8'));
    // What an install rendered from an older template looks like: valid JSON,
    // every path resolved, one newer hook simply never wired.
    parsed.hooks.PreToolUse = parsed.hooks.PreToolUse.filter(
      (entry) => !JSON.stringify(entry).includes('gateguard.mjs'),
    );
    writeFileSync(settings, `${JSON.stringify(parsed, null, 2)}\n`);

    const { verdict, output } = attest(root);
    assert.equal(verdict, 'NONCOMPLIANT', output);
    assert.match(output, /settings hook daemons\/gateguard\.mjs not wired under event/);
    assert.equal(
      output.match(/gateguard\.mjs/g)?.length,
      1,
      `a parsed missing hook should produce one structural finding:\n${output}`,
    );
  });
});

test('an unparsed settings document keeps the raw missing-hook finding', () => {
  withInstall((root) => {
    const manifest = readManifest();
    const settings = path.join(root, ...manifest.required_settings.path.split('/'));
    const parsed = JSON.parse(readFileSync(settings, 'utf8'));
    parsed.hooks.PreToolUse = parsed.hooks.PreToolUse.filter(
      (entry) => !JSON.stringify(entry).includes('gateguard.mjs'),
    );
    writeFileSync(settings, `${JSON.stringify(parsed, null, 2)},\n`);

    const { verdict, status, output } = attest(root);
    assert.deepEqual(
      { verdict, status },
      { verdict: 'NONCOMPLIANT', status: 1 },
      output,
    );
    assert.match(output, /settings JSON malformed: \.claude\/settings\.json/);
    assert.match(output, /settings hook not wired: daemons\/gateguard\.mjs/);
  });
});

test('malformed settings JSON attests NONCOMPLIANT', () => {
  withInstall((root) => {
    const manifest = readManifest();
    const settings = path.join(root, ...manifest.required_settings.path.split('/'));
    const valid = readFileSync(settings, 'utf8').trimEnd();
    // Keep every required command path present while making the document
    // invalid, so a raw substring scan cannot distinguish it from a contract.
    writeFileSync(settings, `${valid},\n`);

    const { verdict, status, output } = attest(root);
    assert.deepEqual(
      { verdict, status },
      { verdict: 'NONCOMPLIANT', status: 1 },
      output,
    );
    assert.match(output, /settings JSON malformed: \.claude\/settings\.json/);
  });
});

test('a wrong statusLine type attests NONCOMPLIANT', () => {
  withInstall((root) => {
    const manifest = readManifest();
    const settings = path.join(root, ...manifest.required_settings.path.split('/'));
    const parsed = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(parsed.statusLine.type, 'command', 'fixture pins the template statusLine type');
    parsed.statusLine.type = 'script';
    writeFileSync(settings, `${JSON.stringify(parsed, null, 2)}\n`);

    const { verdict, status, output } = attest(root);
    assert.deepEqual(
      { verdict, status },
      { verdict: 'NONCOMPLIANT', status: 1 },
      output,
    );
    assert.match(output, /settings statusLine type differs/);
  });
});

test('a required hook under the wrong matcher attests NONCOMPLIANT', () => {
  withInstall((root) => {
    const manifest = readManifest();
    const settings = path.join(root, ...manifest.required_settings.path.split('/'));
    const parsed = JSON.parse(readFileSync(settings, 'utf8'));
    const preToolUse = parsed.hooks.PreToolUse;
    const expectedTuple = preToolUse.find(({ matcher }) => matcher === 'Edit|Write|Bash');
    const hookIndex = expectedTuple.hooks.findIndex(({ command }) => (
      command.includes('gateguard.mjs')
    ));
    assert.notEqual(hookIndex, -1, 'fixture includes the required gateguard hook');
    const [movedHook] = expectedTuple.hooks.splice(hookIndex, 1);
    preToolUse.find(({ matcher }) => matcher === 'Agent').hooks.push(movedHook);
    writeFileSync(settings, `${JSON.stringify(parsed, null, 2)}\n`);

    const { verdict, status, output } = attest(root);
    assert.deepEqual(
      { verdict, status },
      { verdict: 'NONCOMPLIANT', status: 1 },
      output,
    );
    assert.match(output, /settings hook .*daemons\/gateguard\.mjs.*matcher/);
  });
});

test('omitting an empty match-all matcher remains COMPLIANT', () => {
  withInstall((root) => {
    const manifest = readManifest();
    const settings = path.join(root, ...manifest.required_settings.path.split('/'));
    const parsed = JSON.parse(readFileSync(settings, 'utf8'));
    const matchAll = parsed.hooks.SessionStart.find(({ matcher, hooks }) => (
      matcher === ''
      && hooks.some(({ command }) => command.includes('sessionstart-reinject.mjs'))
    ));
    assert.ok(matchAll, 'fixture includes a SessionStart match-all hook');
    delete matchAll.matcher;
    writeFileSync(settings, `${JSON.stringify(parsed, null, 2)}\n`);

    const { verdict, status, output } = attest(root);
    assert.equal(verdict, 'COMPLIANT', output);
    assert.equal(status, 0, 'COMPLIANT exits 0');
  });
});

test('raising a required hook timeout remains COMPLIANT', () => {
  withInstall((root) => {
    const manifest = readManifest();
    const settings = path.join(root, ...manifest.required_settings.path.split('/'));
    const parsed = JSON.parse(readFileSync(settings, 'utf8'));
    const matchAll = parsed.hooks.SessionStart.find(({ matcher, hooks }) => (
      matcher === ''
      && hooks.some(({ command }) => command.includes('sessionstart-reinject.mjs'))
    ));
    const hook = matchAll?.hooks.find(({ command }) => (
      command.includes('sessionstart-reinject.mjs')
    ));
    assert.ok(hook, 'fixture includes the required SessionStart hook');
    hook.timeout += 1000;
    writeFileSync(settings, `${JSON.stringify(parsed, null, 2)}\n`);

    const { verdict, status, output } = attest(root);
    assert.equal(verdict, 'COMPLIANT', output);
    assert.equal(status, 0, 'COMPLIANT exits 0');
  });
});

test('lowering a required hook timeout attests NONCOMPLIANT', () => {
  withInstall((root) => {
    const manifest = readManifest();
    const settings = path.join(root, ...manifest.required_settings.path.split('/'));
    const parsed = JSON.parse(readFileSync(settings, 'utf8'));
    const matchAll = parsed.hooks.SessionStart.find(({ matcher, hooks }) => (
      matcher === ''
      && hooks.some(({ command }) => command.includes('sessionstart-reinject.mjs'))
    ));
    const hook = matchAll?.hooks.find(({ command }) => (
      command.includes('sessionstart-reinject.mjs')
    ));
    assert.ok(hook, 'fixture includes the required SessionStart hook');
    hook.timeout -= 1000;
    writeFileSync(settings, `${JSON.stringify(parsed, null, 2)}\n`);

    const { verdict, status, output } = attest(root);
    assert.deepEqual(
      { verdict, status },
      { verdict: 'NONCOMPLIANT', status: 1 },
      output,
    );
    assert.match(output, /settings hook .*sessionstart-reinject\.mjs.*timeout/);
  });
});

test('unrelated operator settings do not affect a COMPLIANT verdict', () => {
  withInstall((root) => {
    const manifest = readManifest();
    const settings = path.join(root, ...manifest.required_settings.path.split('/'));
    const parsed = JSON.parse(readFileSync(settings, 'utf8'));
    parsed.env.OPERATOR_THEME = 'midnight';
    parsed.permissions = { allow: ['Read'], deny: ['Bash(rm:*)'] };
    parsed.operator = { notifications: true };
    parsed.hooks.OperatorEvent = [
      {
        matcher: 'operator-only',
        hooks: [{ type: 'command', command: 'echo operator hook', timeout: 500 }],
      },
    ];
    writeFileSync(settings, `${JSON.stringify(parsed, null, 2)}\n`);

    const { verdict, status, output } = attest(root);
    assert.equal(verdict, 'COMPLIANT', output);
    assert.equal(status, 0, 'COMPLIANT exits 0');
  });
});

test('an unsubstituted settings placeholder attests NONCOMPLIANT', () => {
  withInstall((root) => {
    const manifest = readManifest();
    cpSync(
      path.join(root, ...manifest.required_settings.template.split('/')),
      path.join(root, ...manifest.required_settings.path.split('/')),
    );

    const { verdict, output } = attest(root);
    assert.equal(verdict, 'NONCOMPLIANT', output);
    assert.match(output, /placeholder not substituted/);
  });
});

test('an unloadable node-pty attests NONCOMPLIANT while Auto-Refresh is expected enabled', () => {
  withInstall((root) => {
    const manifest = readManifest();
    assert.equal(manifest.auto_refresh.expected, 'enabled', 'v1 baseline expects managed Auto-Refresh');
    rmSync(
      path.join(root, ...manifest.managed_runner.dependency_root.split('/'), 'node_modules'),
      { recursive: true, force: true },
    );

    const { verdict, output } = attest(root);
    assert.equal(verdict, 'NONCOMPLIANT', output);
    assert.match(output, /managed runner unavailable/);
  });
});

test('an Auto-Refresh kill switch attests NONCOMPLIANT against an enabled baseline', () => {
  withInstall((root) => {
    const manifest = readManifest();
    const [primaryRoot] = manifest.auto_refresh.kill_switch_roots;
    writeFileSync(
      path.join(
        root,
        ...primaryRoot.split('/'),
        ...manifest.auto_refresh.kill_switch_file.split('/'),
      ),
      '',
    );

    const { verdict, output } = attest(root);
    assert.equal(verdict, 'NONCOMPLIANT', output);
    assert.match(output, /kill switch is set/);
  });
});

test('a missing manifest attests UNKNOWN, not NONCOMPLIANT', () => {
  withInstall((root) => {
    rmSync(path.join(root, 'scripts', 'fleet-baseline-manifest.json'), { force: true });

    const { verdict, status, output } = attest(root);
    // "cannot measure" and "measured, and it is broken" are different facts.
    // Collapsing them would let a fleet gate read an unreadable manifest as a
    // failing install, or worse, the reverse.
    assert.equal(verdict, 'UNKNOWN', output);
    assert.equal(status, 2, 'UNKNOWN exits 2, distinct from NONCOMPLIANT exit 1');
  });
});

test('an unreadable manifest attests UNKNOWN', () => {
  withInstall((root) => {
    writeFileSync(path.join(root, 'scripts', 'fleet-baseline-manifest.json'), '{ not json');

    const { verdict, status, output } = attest(root);
    assert.equal(verdict, 'UNKNOWN', output);
    assert.equal(status, 2);
  });
});

test('an absent optional component attests DEGRADED, everything else exact', () => {
  withInstall((root) => {
    const manifest = readManifest();
    rmSync(
      path.join(root, ...manifest.optional_components.semantic_search.path.split('/')),
      { recursive: true, force: true },
    );

    const { verdict, status, output } = attest(root);
    assert.equal(verdict, 'DEGRADED', output);
    assert.equal(status, 0, 'DEGRADED is not a failure exit');
  });
});

// An optional absence must never pull a broken install back up to DEGRADED.
test('an optional absence alongside a required failure stays NONCOMPLIANT', () => {
  withInstall((root) => {
    const manifest = readManifest();
    rmSync(
      path.join(root, ...manifest.optional_components.semantic_search.path.split('/')),
      { recursive: true, force: true },
    );
    const [target] = Object.keys(manifest.required_files);
    const file = path.join(root, ...target.split('/'));
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n`);

    const { verdict, output } = attest(root);
    assert.equal(verdict, 'NONCOMPLIANT', output);
  });
});

test('--attest writes nothing into the tree it attests', () => {
  withInstall((root) => {
    const before = digest(root);
    attest(root);
    assert.equal(digest(root), before, '--attest must not modify the attested tree');
  });
});

// -- FleetBaselineManifest/v6 -------------------------------------------------

const REGISTRY = 'daemons/semantic-search/namespace-registry.json';

test('v6 manifest identity pins the recut population', () => {
  const manifest = readManifest();
  assert.equal(manifest.schema, 'FleetBaselineManifest/v6');
  assert.equal(manifest.baseline_id, 'aigent-os-2026-08-24-867cb2ea');
  assert.equal(
    manifest.public_product_commit,
    '867cb2ea3a27a83fac2f916bdf5ec799d45b70c8',
  );
  assert.ok(
    manifest.baseline_id.endsWith(manifest.public_product_commit.slice(0, 8)),
    'baseline_id embeds the commit prefix it was cut from',
  );
  assert.match(
    manifest.required_files[REGISTRY] ?? '',
    /^[0-9a-f]{64}$/,
    'the product namespace policy artifact is pinned',
  );
});

test('every declared required path exists in the tree with no duplicate declarations', () => {
  const manifest = readManifest();
  const declared = Object.keys(manifest.required_files);
  for (const relative of declared) {
    const full = path.join(REPO, ...relative.split('/'));
    assert.ok(
      existsSync(full) && statSync(full).isFile(),
      `declared required path missing from the tree: ${relative}`,
    );
  }
  assert.equal(
    new Set(declared.map((key) => path.posix.normalize(key))).size,
    declared.length,
    'two declarations normalize to the same path',
  );
  // JSON.parse collapses duplicate keys silently, so the parsed object can
  // never show one. Count declarations in the raw manifest text instead.
  const raw = readFileSync(MANIFEST, 'utf8');
  const block = raw.slice(raw.indexOf('"required_files"'), raw.indexOf('"required_settings"'));
  const rawDeclarations = block.match(/"[^"\n]+": "[0-9a-f]{64}"/g) ?? [];
  assert.equal(
    rawDeclarations.length,
    declared.length,
    'raw manifest text declares a required path the parsed object lost (duplicate key)',
  );
});

test('every declared required path resolves at the pinned source commit', (t) => {
  const manifest = readManifest();
  const commit = manifest.public_product_commit;
  const probe = spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${commit}^{commit}`]);
  if (probe.status !== 0) {
    // Only a shallow clone excuses the missing object. In a full clone an
    // unreachable public_product_commit means the manifest pins a wrong or
    // rewritten commit -- that must FAIL, not skip.
    const shallow = spawnSync('git', ['-C', REPO, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' });
    assert.equal(
      shallow.stdout?.trim(),
      'true',
      `pinned commit ${commit} is unreachable in a full clone -- wrong or rewritten public_product_commit`,
    );
    t.skip(`pinned commit ${commit.slice(0, 8)} not present (shallow clone)`);
    return;
  }
  // core.quotePath=false: without it, git C-quotes any non-ASCII byte in a
  // path and Set.has never matches the raw UTF-8 manifest key.
  const tree = spawnSync('git', ['-C', REPO, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', commit], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(tree.status, 0, `git ls-tree failed for ${commit.slice(0, 8)}`);
  const present = new Set(tree.stdout.split('\n'));
  for (const relative of Object.keys(manifest.required_files)) {
    assert.ok(present.has(relative), `not present at ${commit.slice(0, 8)}: ${relative}`);
  }
});

test('a byte changed in the namespace policy artifact attests NONCOMPLIANT', () => {
  withInstall((root) => {
    const file = path.join(root, ...REGISTRY.split('/'));
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n`);

    const { verdict, status, output } = attest(root);
    assert.equal(verdict, 'NONCOMPLIANT', output);
    assert.equal(status, 1, 'NONCOMPLIANT exits 1');
    assert.match(output, /required file changed: daemons\/semantic-search\/namespace-registry\.json/);
  });
});

// namespace-registry.local.json (issue #48) is deliberately unpinned: it is
// operator-owned, so it is not in required_files and --attest never reads its
// content. This proves that by construction rather than by inspection -- a
// populated local registry present on a fresh install stays COMPLIANT, and
// tampering the CORE registry still flips NONCOMPLIANT with the local file
// present, so the two never get coupled by a future manifest change.
test('a populated local namespace registry does not affect --attest, and core tamper still attests NONCOMPLIANT with it present', () => {
  withInstall((root) => {
    const localFile = path.join(root, 'daemons', 'semantic-search', 'namespace-registry.local.json');
    writeFileSync(localFile, JSON.stringify({
      schema: 'MemoryNamespaceRegistry/v1',
      namespaces: [{ path: 'operator-extension', disposition: 'INDEX' }],
    }, null, 2));

    const green = attest(root);
    assert.equal(green.verdict, 'COMPLIANT', green.output);
    assert.equal(green.status, 0, 'populated local registry keeps the fresh install COMPLIANT');

    const coreFile = path.join(root, ...REGISTRY.split('/'));
    writeFileSync(coreFile, `${readFileSync(coreFile, 'utf8')}\n`);
    const red = attest(root);
    assert.equal(red.verdict, 'NONCOMPLIANT', red.output);
    assert.equal(red.status, 1, 'NONCOMPLIANT exits 1');
    assert.match(red.output, /required file changed: daemons\/semantic-search\/namespace-registry\.json/);
  });
});

// THE v3 MUTATION WITNESS. The expected namespace-registry hash is flipped in
// the installed manifest while the artifact on disk stays untouched: the
// exact-install case must turn red, and a byte-identical restore must turn it
// green again -- proving the green depends on exactly these bytes.
test('flipping the expected namespace-registry hash turns the exact install red; restoring turns it green', () => {
  withInstall((root) => {
    const installed = path.join(root, 'scripts', 'fleet-baseline-manifest.json');
    const original = readFileSync(installed);

    assert.equal(attest(root).verdict, 'COMPLIANT', 'exact install is green before the mutation');

    const manifest = JSON.parse(original.toString('utf8'));
    assert.ok(manifest.required_files[REGISTRY], 'fixture manifest pins the registry');
    manifest.required_files[REGISTRY] = 'f'.repeat(64);
    writeFileSync(installed, `${JSON.stringify(manifest, null, 2)}\n`);

    const red = attest(root);
    assert.equal(red.verdict, 'NONCOMPLIANT', red.output);
    assert.match(red.output, /required file changed: daemons\/semantic-search\/namespace-registry\.json/);

    writeFileSync(installed, original);
    const green = attest(root);
    assert.equal(green.verdict, 'COMPLIANT', green.output);
    assert.equal(green.status, 0, 'byte-identical restore returns the exact install to green');
  });
});

// Locks the population line's presence and format. Both sides parse the same
// manifest bytes, so this does NOT independently detect truncation -- the
// duplicate-declaration raw-text case above carries that coverage.
test('attest output states the declared population count', () => {
  withInstall((root) => {
    const { output } = attest(root);
    const count = Object.keys(readManifest().required_files).length;
    assert.match(
      output,
      new RegExp(`population ${count} required files`),
      'the population line must state the declared required-file count',
    );
  });
});
