import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Dream and nightly print the newest dated file in both daily trees', (t) => {
  for (const skill of ['dream', 'nightly']) {
    const doc = readFileSync(new URL('../../skills/' + skill + '/SKILL.md', import.meta.url), 'utf8');
    assert.ok(doc.includes('<root>/vault/daily'), skill + ' must name the live hook tree');
    assert.ok(doc.includes('daemons/dream-daily.mjs'), skill + ' must run the inventory');
  }
  const root = mkdtempSync(path.join(tmpdir(), 'dream-daily-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['.aigent', 'vault/daily', 'notes/daily', 'notes/mem']) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  writeFileSync(path.join(root, '.aigent/state.json'), '{"memory_root":"notes/mem"}');
  const inventory = () => execFileSync(process.execPath, [
    fileURLToPath(new URL('../dream-daily.mjs', import.meta.url)), '--root', root,
  ], { encoding: 'utf8', env: { ...process.env, AIGENT_STATE_HOME_DIR: root } });
  assert.match(inventory(), /notes\/daily.*none/);
  for (const file of ['vault/daily/2026-11-12.md', 'notes/daily/2026-11-12.md',
    'vault/daily/2026-11-13.md', 'vault/daily/README.md']) writeFileSync(path.join(root, file), '');
  assert.match(inventory(), /vault\/daily.*2026-11-13\.md/);
  assert.match(inventory(), /notes\/daily.*2026-11-12\.md/);
});
