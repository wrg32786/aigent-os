// Contract/security tests use loopback HTTP only, never real accounts or models.
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadBridge, inspectSource, retain, recall, reflect, rank, localRecall } from '../memory-bridge.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const A = 'research/a.md';
const B = 'research/b.md';
const QUERY = 'Which source explains the design?';

test('memory bridge: actual HTTP path, current policy, provenance and degraded modes', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'aigent-bridge-test-'));
  const vault = path.join(root, 'vault');
  const sem = path.join(root, 'daemons', 'semantic-search');
  const configFile = path.join(root, '.aigent', 'memory-bridge.json');
  for (const p of [sem, path.dirname(configFile), ...['research', 'private', 'templates', 'memory'].map((p) => path.join(vault, p))]) mkdirSync(p, { recursive: true });
  const registry = { schema: 'MemoryNamespaceRegistry/v1', namespaces: [
    { path: 'research', disposition: 'INDEX' }, { path: 'memory', disposition: 'INDEX' },
    { path: 'private', disposition: 'DENY', reason: 'test' }, { path: 'templates', disposition: 'SKIP', reason: 'test' },
  ] };
  writeFileSync(path.join(sem, 'namespace-registry.json'), JSON.stringify(registry));
  const textA = '# Alpha\nA local source with a reviewed design.';
  const textB = '# Beta\nAnother source about the implementation.';
  writeFileSync(path.join(vault, A), textA);
  writeFileSync(path.join(vault, B), textB);
  writeFileSync(path.join(vault, 'private', 'secret.md'), 'DENIED-CANARY');
  writeFileSync(path.join(vault, 'templates', 'skip.md'), 'SKIP-CANARY');
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'synthetic-test-key';
  const calls = [];
  const stored = new Map();
  let mode = '';
  let recallOverride = null;
  let reflectionOverride = null;
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    calls.push({ url: req.url, body, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'unauthorized') { res.writeHead(401); res.end('SECRET-ERROR-ECHO'); return; }
    if (mode === 'error') { res.writeHead(503); res.end('SECRET-ERROR-ECHO'); return; }
    if (mode === 'timeout') { return; }
    if (mode === 'redirect') { res.writeHead(307, { Location: '/redirect-target' }); res.end('{}'); return; }
    if (mode === 'oversized') { res.end(JSON.stringify({ huge: 'x'.repeat(270000) })); return; }
    if (mode === 'invalid-json') { res.end('not-json'); return; }
    if (mode === 'edit-during-request') writeFileSync(path.join(vault, A), 'changed after egress');
    if (req.url.endsWith('/memories')) {
      for (const item of body.items) stored.set(item.document_id, item);
      res.end(JSON.stringify({ success: true, bank_id: 'unit-bank', items_count: body.items.length, async: false }));
    } else if (req.url.endsWith('/memories/recall')) {
      const rows = [...stored.values()].map((item, i) => ({ id: `fact-${i}`, type: 'world', text: `Extracted fact ${i}`,
        document_id: item.document_id, metadata: item.metadata, tags: item.tags }));
      res.end(JSON.stringify({ results: recallOverride ?? rows }));
    } else if (req.url === '/v1/systemone') {
      const keys = Object.keys(body.questions.rank.criteria);
      const p = Object.fromEntries(keys.map((k, i) => [k, i === keys.length - 1 ? 1 : 0]));
      if (mode === 'bad-probability') p[keys[0]] = '0.5';
      if (mode === 'extra-choice') p.extra = 0;
      if (mode === 'missing-choice') delete p[keys[0]];
      res.end(JSON.stringify({ model: 'jev-test', answers: { rank: { type: 'choice', choice: keys[keys.length - 1], probabilities: p, confidence: 1 } } }));
    } else if (req.url.endsWith('/reflect')) {
      res.end(JSON.stringify(reflectionOverride ?? { text: 'Candidate lesson.\nDo not treat this as approval.', based_on: { memories: [{ id: 'fact-0' }], mental_models: [], directives: [] } }));
    } else { res.writeHead(404); res.end('{}'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previousKey;
  });
  const config = () => ({ schema: 'MemoryBridge/v1', sources: { [A]: sha(textA), [B]: sha(textB) },
    hindsight: { enabled: true, url, bank: 'unit-bank', allowQueries: true, allowSources: true, timeoutMs: 1000 },
    jev: { enabled: true, url, model: 'jev-test', allowQueries: true, allowSources: true, timeoutMs: 1000 },
  });
  const setConfig = (cfg = config()) => { writeFileSync(configFile, JSON.stringify(cfg)); return loadBridge({ root }); };
  const local = [{ path: A, score: 0.8 }, { path: B, score: 0.6 }];

  await t.test('absent configuration never contacts either provider', async () => {
    const out = await recall(loadBridge({ root }), QUERY, local);
    assert.equal(calls.length, 0); assert.equal(out.results.length, 2);
    assert.equal(out.answerability, 'not-evaluated'); assert.equal(out.authority, 'none');
  });
  await t.test('local-only recall accepts punctuation, Unicode and large notes without export approval', async () => {
    const names = ['research/notes, revised.md', "research/O'Brien & (design)#1.md", 'research/记忆.md', 'research/large.md'];
    const large = '# Local preview\n' + 'x'.repeat(70000);
    for (const name of names) writeFileSync(path.join(vault, name), name.endsWith('large.md') ? large : '# Ordinary local note');
    try {
      const before = calls.length;
      const out = await recall(loadBridge({ root }), QUERY, names.map((name) => ({ path: name, score: 0.6 })));
      assert.deepEqual(out.results.map((r) => r.path), names); assert.equal(out.status, 'ok');
      assert.equal(out.results.at(-1).source_sha256, sha(large));
      assert(out.results.at(-1).chunk.length < 1600); assert.equal(calls.length, before);
    } finally { for (const name of names) rmSync(path.join(vault, name)); }
  });
  await t.test('missing local sources are counted separately from policy withholding', async () => {
    const before = calls.length;
    const out = await recall(loadBridge({ root }), QUERY, [
      { path: 'research/absent.md' }, { path: 'research/also-absent.md' }, { path: 'private/secret.md' },
    ]);
    assert.deepEqual(out.notices, [
      { provider: 'local', code: 'source-missing', count: 2 },
      { provider: 'local', code: 'source-withheld', count: 1 },
    ]);
    assert.equal(calls.length, before);
  });
  await t.test('retains approved exact bytes with stable document identity and source metadata', async () => {
    const ctx = setConfig();
    const first = await retain(ctx, A);
    const second = await retain(ctx, A);
    assert.equal(first.status, 'retained'); assert.equal(first.document_id, second.document_id);
    assert.equal(stored.size, 1); assert.equal(calls.at(-1).body.items[0].content, textA);
    assert.equal(calls.at(-1).body.items[0].metadata.aigent_source_sha256, sha(textA));
    assert.equal(calls.at(-1).body.async, false);
    await retain(ctx, B);
  });
  await t.test('recalls via native Hindsight bank endpoint and keeps local score semantics', async () => {
    const cfg = config(); cfg.jev.enabled = false;
    const out = await recall(setConfig(cfg), QUERY, []);
    assert.equal(out.results.length, 2); assert.equal(out.results[0].origin, 'hindsight');
    assert.equal(out.results[0].chunkProvenance.authority, 'none');
    const body = calls.at(-1).body;
    assert.equal(body.tags_match, 'any_strict'); assert.equal(body.tags.length, 2);
    assert.deepEqual(body.types, ['world', 'experience']);
  });
  await t.test('Jev returns only a permutation; no pruning or overwritten cosine scores', async () => {
    const out = await rank(setConfig(), QUERY, local);
    assert.deepEqual(out.rows.map((r) => r.path), [B, A]);
    assert.equal(out.rows[0].score, 0.6); assert.equal(out.ranking, 'jev-relative-order-only');
    assert.equal(calls.at(-1).authorization, 'Bearer synthetic-test-key');
    assert.deepEqual(Object.keys(calls.at(-1).body.questions), ['rank']);
  });
  await t.test('DENY, SKIP, traversal and unapproved versions cause no egress', async () => {
    const ctx = setConfig(); const before = calls.length;
    for (const name of ['private/secret.md', 'templates/skip.md', '../research/a.md', 'research/../a.md', '/research/a.md', 'research\\a.md', 'research/a.md:stream']) {
      await assert.rejects(retain(ctx, name));
    }
    writeFileSync(path.join(vault, A), 'changed and not approved');
    await assert.rejects(retain(ctx, A));
    assert.equal(calls.length, before); writeFileSync(path.join(vault, A), textA);
  });
  await t.test('symbolic links never grant source access', (t) => {
    const linked = path.join(vault, 'research', 'link.md');
    try { symlinkSync(path.join(vault, A), linked, 'file'); }
    catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('symlink privilege unavailable'); return; } throw e; }
    assert.throws(() => inspectSource(setConfig(), 'research/link.md'), /symlink/);
    rmSync(linked);
  });
  await t.test('hardlinked source cannot be approved for export', () => {
    const linked = path.join(vault, 'research', 'hardlink.md');
    linkSync(path.join(vault, A), linked);
    try { assert.throws(() => inspectSource(setConfig(), A, true), /source-hardlink-refused/); }
    finally { rmSync(linked); }
  });
  await t.test('directory junction or symlink cannot escape the vault', (t) => {
    const outside = path.join(root, 'outside'); mkdirSync(outside);
    writeFileSync(path.join(outside, 'escape.md'), 'OUTSIDE-CANARY');
    const link = path.join(vault, 'research', 'junction');
    try { symlinkSync(outside, link, 'junction'); }
    catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('junction privilege unavailable'); return; } throw e; }
    try { assert.throws(() => inspectSource(setConfig(), 'research/junction/escape.md'), /source-symlink-refused|source-outside-vault/); }
    finally { rmSync(link, { recursive: true, force: true }); rmSync(outside, { recursive: true }); }
  });
  await t.test('realpath containment independently refuses an outside-vault resolution', (t) => {
    const ctx = setConfig(); const real = fs.realpathSync;
    t.mock.method(fs, 'realpathSync', (file, ...args) => file === path.join(ctx.vault, A) ? path.join(ctx.root, 'outside.md') : real(file, ...args));
    syncBuiltinESMExports();
    try { assert.throws(() => inspectSource(ctx, A, true), /source-outside-vault/); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
  await t.test('direct Jev rank rejects an unapproved row without a request', async () => {
    const name = 'research/unapproved.md'; writeFileSync(path.join(vault, name), 'UNAPPROVED-EGRESS-CANARY');
    try {
      const before = calls.length;
      await assert.rejects(rank(setConfig(), QUERY, [...local, { path: name }]), /source-not-approved-at-this-version/);
      assert.equal(calls.length, before);
    } finally { rmSync(path.join(vault, name)); }
  });
  await t.test('recall ranks approved slots without exporting or moving an unapproved slot', async () => {
    const name = 'research/unapproved.md'; writeFileSync(path.join(vault, name), 'UNAPPROVED-EGRESS-CANARY');
    try {
      const cfg = config(); cfg.hindsight.enabled = false;
      const before = calls.length;
      const out = await recall(setConfig(cfg), QUERY, [local[0], { path: name, score: 0.7 }, local[1]]);
      assert.equal(calls.length, before + 1); assert.equal(out.ranking, 'jev-relative-order-only');
      assert.deepEqual(out.results.map((r) => r.path), [B, name, A]);
      assert.equal(Object.keys(calls.at(-1).body.questions.rank.criteria).length, 2);
      assert(!JSON.stringify(calls.slice(before)).includes('UNAPPROVED-EGRESS-CANARY'));
    } finally { rmSync(path.join(vault, name)); }
  });
  await t.test('query approval is separate from source approval', async () => {
    const cfg = config(); cfg.hindsight.allowQueries = false; cfg.jev.allowQueries = false;
    const before = calls.length;
    const out = await recall(setConfig(cfg), QUERY, local);
    assert.equal(calls.length, before); assert.equal(out.results.length, 2); assert.equal(out.status, 'degraded');
  });
  await t.test('source approval is required independently for Jev', async () => {
    const cfg = config(); cfg.jev.allowSources = false;
    const ctx = setConfig(cfg); const before = calls.length;
    await assert.rejects(rank(ctx, QUERY, local), /source-egress-not-approved/);
    assert.equal(calls.length, before);
  });
  await t.test('malformed namespace or deny policy fails closed before any request', async () => {
    const ctx = setConfig(); const before = calls.length;
    const file = path.join(sem, 'index-deny.json'); writeFileSync(file, '{');
    await assert.rejects(recall(ctx, QUERY, local)); assert.equal(calls.length, before); rmSync(file);
    const regFile = path.join(sem, 'namespace-registry.json'); const old = readFileSync(regFile);
    writeFileSync(regFile, '{}'); await assert.rejects(recall(ctx, QUERY, local));
    assert.equal(calls.length, before); writeFileSync(regFile, old);
  });
  await t.test('unknown physical namespaces are not silently skipped', async () => {
    const ctx = setConfig(); mkdirSync(path.join(vault, 'unknown'));
    await assert.rejects(recall(ctx, QUERY, local), /undeclared/); rmSync(path.join(vault, 'unknown'), { recursive: true });
  });
  await t.test('unknown, wrong-bank and stale remote source references are withheld', async () => {
    const item = [...stored.values()][0];
    const good = { id: 'fact-test', text: 'DO-NOT-PRINT', type: 'world', document_id: [...stored.keys()][0], metadata: item.metadata, tags: item.tags };
    recallOverride = [
      { ...good, metadata: { ...item.metadata, aigent_bank: 'other-bank' } },
      { ...good, metadata: { ...item.metadata, aigent_source_sha256: '0'.repeat(64) } },
      { ...good, document_id: 'foreign-document' },
      { ...good, metadata: { ...item.metadata, aigent_source_path: 'private/secret.md' } },
    ];
    const cfg = config(); cfg.jev.enabled = false;
    const out = await recall(setConfig(cfg), QUERY, []);
    assert.equal(out.results.length, 0); assert.equal(out.status, 'degraded'); assert(!JSON.stringify(out).includes('DO-NOT-PRINT'));
    recallOverride = null;
  });
  for (const failure of ['error', 'timeout', 'redirect', 'oversized', 'invalid-json']) {
    await t.test(`provider ${failure} preserves local fallback and does not expose error bodies`, async () => {
      mode = failure; const cfg = config(); cfg.jev.enabled = false; cfg.hindsight.timeoutMs = 100;
      const before = calls.length; const out = await recall(setConfig(cfg), QUERY, local);
      assert.equal(out.status, 'degraded'); assert.deepEqual(out.results.map((r) => r.path), [A, B]);
      assert.equal(calls.length, before + 1); assert(!JSON.stringify(out).includes('SECRET-ERROR-ECHO'));
      mode = '';
    });
  }
  for (const failure of ['bad-probability', 'extra-choice', 'missing-choice']) {
    await t.test(`Jev ${failure} cannot alter local order`, async () => {
      mode = failure; const cfg = config(); cfg.hindsight.enabled = false;
      const out = await recall(setConfig(cfg), QUERY, local);
      assert.equal(out.status, 'degraded'); assert.deepEqual(out.results.map((r) => r.path), [A, B]); mode = '';
    });
  }
  await t.test('changed source during a remote call is not rendered as current evidence', async () => {
    mode = 'edit-during-request'; const cfg = config(); cfg.jev.enabled = false;
    const out = await recall(setConfig(cfg), QUERY, local);
    assert(!out.results.some((r) => r.path === A)); mode = ''; writeFileSync(path.join(vault, A), textA);
  });
  await t.test('retention failures are unknown, never a success or automatic retry', async () => {
    mode = 'error'; const before = calls.length;
    const out = await retain(setConfig(), A);
    assert.equal(out.status, 'unknown'); assert.equal(calls.length, before + 1); mode = '';
  });
  await t.test('retain reports a rejected credential as refused, not an ambiguous write', async () => {
    mode = 'unauthorized'; const before = calls.length;
    try {
      const out = await retain(setConfig(), A);
      assert.equal(out.status, 'refused'); assert.equal(out.code, 'http-401'); assert.equal(out.retry, undefined);
      assert.equal(calls.length, before + 1); assert(!JSON.stringify(out).includes('SECRET-ERROR-ECHO'));
    } finally { mode = ''; }
  });
  await t.test('retain rejects the encoded-size limit before any request', async () => {
    const name = 'research/encoded-limit.md'; const text = '\t'.repeat(60000);
    writeFileSync(path.join(vault, name), text);
    try {
      const cfg = config(); cfg.sources[name] = sha(text);
      const before = calls.length;
      const out = await retain(setConfig(cfg), name);
      assert.equal(out.status, 'refused'); assert.equal(out.code, 'request-too-large'); assert.equal(calls.length, before);
    } finally { rmSync(path.join(vault, name)); }
  });
  await t.test('confirmed retain stays retained when the local revision changes in flight', async () => {
    mode = 'edit-during-request';
    try {
      const out = await retain(setConfig(), A);
      assert.equal(out.status, 'retained'); assert.equal(out.source_sha256, sha(textA));
      assert.equal(out.notices[0].code, 'source-changed-after-retain');
    } finally { mode = ''; writeFileSync(path.join(vault, A), textA); }
  });
  await t.test('reflection is an inert HOLD candidate with checked local source links', async () => {
    const out = await reflect(setConfig(), QUERY);
    assert.equal(out.status, 'hold'); assert.equal(out.authority, 'none'); assert.equal(out.evidence.length, 1);
    assert.equal(out.provenance.authority, 'none'); assert(!out.text.includes('\n'));
  });
  await t.test('unknown reflection evidence and external directives cannot enter a candidate', async () => {
    reflectionOverride = { text: 'UNVERIFIED-SECRET', based_on: { memories: [{ id: 'foreign-fact' }] } };
    await assert.rejects(reflect(setConfig(), QUERY), /reflection-source-proof-incomplete/);
    reflectionOverride = { text: 'UNVERIFIED-SECRET', based_on: { memories: [{ id: 'fact-0' }], directives: [{ id: 'approve' }] } };
    await assert.rejects(reflect(setConfig(), QUERY), /reflection-source-proof-incomplete/); reflectionOverride = null;
  });
  await t.test('reflection cannot ignore unverified observations or a future evidence type', async () => {
    try {
      for (const key of ['observations', 'unknown_evidence']) {
        reflectionOverride = { text: 'UNVERIFIED-SECRET', based_on: { memories: [{ id: 'fact-0' }], [key]: [{ id: 'unchecked' }] } };
        await assert.rejects(reflect(setConfig(), QUERY), /reflection-source-proof-incomplete/);
      }
      reflectionOverride = { text: 'safe candidate', based_on: { memories: [{ id: 'fact-0' }], observations: [] } };
      assert.equal((await reflect(setConfig(), QUERY)).status, 'hold');
    } finally { reflectionOverride = null; }
  });
  await t.test('the wrapper actually invokes the existing local search CLI', async () => {
    writeFileSync(path.join(sem, 'search-vault.js'), `console.log(JSON.stringify([{path:${JSON.stringify(A)},score:0.7}]))`);
    const out = await localRecall(setConfig(), QUERY);
    assert.equal(out.rows[0].path, A); assert.equal(out.notices.length, 0);
  });
  await t.test('local search cannot inherit another seat memory root', async () => {
    const previous = process.env.AIGENT_STATE_HOME_DIR;
    process.env.AIGENT_STATE_HOME_DIR = '/another-seat';
    try {
      writeFileSync(path.join(sem, 'search-vault.js'), `console.log(JSON.stringify([{path:process.env.AIGENT_STATE_HOME_DIR}]))`);
      const out = await localRecall(setConfig(), QUERY);
      assert.equal(out.rows[0].path, realpathSync(root));
    } finally {
      if (previous === undefined) delete process.env.AIGENT_STATE_HOME_DIR;
      else process.env.AIGENT_STATE_HOME_DIR = previous;
    }
  });
  await t.test('an explicitly selected state home uses the native memory-root declaration', async () => {
    const stateHome = path.join(root, 'selected-state');
    mkdirSync(path.join(stateHome, '.aigent'), { recursive: true });
    mkdirSync(path.join(stateHome, 'selected-memory'));
    writeFileSync(path.join(stateHome, '.aigent', 'state.json'), JSON.stringify({ memory_root: 'selected-memory' }));
    const resolver = fileURLToPath(new URL('../memory-root.cjs', import.meta.url));
    writeFileSync(path.join(sem, 'search-vault.js'), `const {resolveMemoryRoot}=require(${JSON.stringify(resolver)}); console.log(JSON.stringify([{path:resolveMemoryRoot(process.env.AIGENT_STATE_HOME_DIR)}]));`);
    setConfig();
    const out = await localRecall(loadBridge({ root, stateHome }), QUERY);
    assert.equal(out.rows[0].path, path.join(realpathSync(stateHome), 'selected-memory')); assert.deepEqual(out.notices, []);
    writeFileSync(path.join(stateHome, '.aigent', 'state.json'), JSON.stringify({ memory_root: '../outside' }));
    const invalid = await localRecall(loadBridge({ root, stateHome }), QUERY);
    assert.deepEqual(invalid.notices, [{ provider: 'local', code: 'memory-root-invalid' }]);
  });
  await t.test('unsupported native argv query shapes are refused instead of rewritten', async () => {
    for (const q of ['--not-a-flag', '16']) {
      const out = await localRecall(setConfig(), q);
      assert.deepEqual(out.rows, []); assert.deepEqual(out.notices, [{ provider: 'local', code: 'local-query-argv-unsupported' }]);
    }
  });
  await t.test('configuration edits invalidate an in-memory bridge', async () => {
    const ctx = setConfig(); const cfg = config(); cfg.jev.enabled = false; setConfig(cfg);
    await assert.rejects(retain(ctx, A), /configuration-changed/);
  });
  await t.test('insecure endpoints and malformed configuration are refused', () => {
    const cfg = config(); cfg.hindsight.url = 'http://example.org';
    assert.throws(() => setConfig(cfg), /endpoint-insecure/);
    cfg.hindsight.url = url; cfg.jev.url = 'https://unapproved.example';
    assert.throws(() => setConfig(cfg), /jev-endpoint-not-approved/);
    writeFileSync(configFile, '{'); assert.throws(() => loadBridge({ root }), /configuration-invalid/);
  });
});
