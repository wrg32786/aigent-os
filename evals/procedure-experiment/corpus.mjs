// Read historical test data, never import or execute the historical tests.
// This explicit projection preserves their unresolved-id assertions, not rendering.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export function deriveCorpus(manifest, cwd) {
  const source = execFileSync('git', ['show', `${manifest.commit}:${manifest.path}`], { cwd, windowsHide: true });
  const blob = createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
  if (blob !== manifest.blob) throw new Error('UNKNOWN/HOLD: historical corpus blob mismatch');
  const text = source.toString('utf8');
  const rows = new Map([...text.matchAll(/test\('row (\d+): ([^']+)'[^]*?(?=\ntest\('|$)/g)]
    .map((m) => [Number(m[1]), { title: m[2], text: m[0] }]));
  const take = (n, re) => {
    const match = rows.get(n)?.text.match(re);
    if (!match) throw new Error(`UNKNOWN/HOLD: historical row ${n} cannot be projected`);
    return match;
  };
  const quoted = (s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const pending = text.match(/function setup\(t, events = \[call\('([^']+)'\)\]/)?.[1];
  if (!pending) throw new Error('UNKNOWN/HOLD: missing historical default operation');
  // Normalized kind and target are placeholders; equality/difference is preserved.
  const row = (op = pending, outcome = 'unknown', extra = {}) => ({ op, kind: 'mail', target: 'a', outcome, ...extra });
  const cap = (id, values = [], extra = {}) => ({ id, scope: 'local', writer: true, rows: values, ...extra });
  const selected = (values = []) => cap('selected', values, { writer: false });
  const cases = [];
  const add = (n, suffix, artifacts, expected) => cases.push({
    id: `historical-${n}${suffix}`, class: 'held-out', source_row: n, source_title: rows.get(n).title,
    scope: 'local', selected: 'selected', artifacts, expected: [...expected].sort(),
  });
  take(1, /original\[0\]\.slice\(2\)/);
  add(1, '', [selected([row()])], [pending]);
  const statuses = quoted(take(2, /const sources = \[([^\]]+)\]/)[1]);
  const outcomes = take(2, /outcome: i % 2 \? '([^']+)' : '([^']+)'/);
  const prefix = take(2, /op: `([^`]+)-\$\{status\}`/)[1];
  take(2, /for \(const s of sources\) carried\(a, s\.r/);
  statuses.forEach((status, i) => {
    const op = `${prefix}-${status}`;
    add(2, `-${status}`, [cap(`source-${status}`, [row(op, outcomes[i % 2 ? 1 : 2])], { status }), selected()], [op]);
  });
  const operations = quoted(take(3, /setup\(t, \[call\('([^']+)'\), call\('([^']+)'\)\]/)[0]);
  take(3, /lineFor\(text, 'accepted'\), undefined/);
  take(3, /lineFor\(text, 'rejected'\), undefined/);
  add(3, '', [cap('unresolved', operations.map((op) => row(op))),
    cap('writer-resolution', operations.map((op, i) => row(op, i ? 'failed' : 'confirmed', { kind: 'sidechain:mail' }))),
    selected([row('selected-confirmed', 'confirmed')])], []);
  const ownership = [...take(4, /for \(const \[id, ownership\] of \[([^]*?)\]\) add/)[1]
    .matchAll(/\['([^']+)',/g)].map((m) => m[1]);
  take(4, /carried\(f\.resume\(\), original\[0\], 'unresolved'\)/);
  add(4, '', [cap('unresolved', [row()]), ...ownership.map((id) => cap(id, [row(pending, 'confirmed')], { writer: false })),
    cap('prose', [], { evidence: 'this landed, safe to retry' }), selected()], [pending]);
  const wrongKind = take(5, /kind: '([^']+)', outcome: '([^']+)'/);
  const wrongTarget = take(5, /target: '([^']+)', outcome: '([^']+)'/);
  take(5, /carried\(f\.resume\(\), original\[0\], 'unresolved'\)/);
  // Keep both historical mismatches together, as in the original test row.
  add(5, '', [cap('unresolved', [row()]), cap('wrong-identity', [
    row(pending, wrongKind[2], { kind: wrongKind[1] }), row(pending, wrongTarget[2], { target: wrongTarget[1] }),
  ]), selected()], [pending]);
  take(6, /carried\(f\.resume\(\), original\[0\], 'curated-pending'\)/);
  add(6, '', [cap('curated-pending', [row()], { writer: false }), selected()], [pending]);
  const foreign = take(8, /row\(\{ op: '([^']+)' \}\)/)[1];
  take(8, /carried\(text, original\[0\], 'local-pending'\)/);
  take(8, /lineFor\(text, 'foreign-only'\), undefined/);
  add(8, '', [cap('local-pending', [row()]), cap('foreign', [row(pending, 'confirmed'), row(foreign)], { scope: 'elsewhere' }), selected()], [pending]);
  const done = take(10, /call\('([^']+)'\), result\('\1'\)/)[1];
  take(10, /assert\.equal\(after, before\)/);
  add(10, '', [cap('old-resolved', [row(done, 'confirmed')]), selected([row(done, 'confirmed')])], []);
  if (JSON.stringify([...new Set(cases.map((c) => c.source_row))]) !== JSON.stringify(manifest.rows)) {
    throw new Error('UNKNOWN/HOLD: historical row coverage mismatch');
  }
  return { source, provenance: { ...manifest, blob }, cases };
}
