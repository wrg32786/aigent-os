import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as core from '../lifecycle-common.mjs';
import * as plugin from '../../plugins/context-capsule/scripts/capsule-sections.mjs';
import { buildCapsule } from '../../plugins/context-capsule/scripts/capsule-lib.mjs';
import { fixture, user } from './helpers/capsule-fixture.mjs';

const source = (name) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const keys = ['done', 'errors', 'rejected', 'files', 'facts', 'effects', 'gates', 'rows'];
const pluginHeadings = [
  ["Done (don't redo)", '<!-- swe:done -->'],
  ['Historical-Errors -> Resolutions', '<!-- swe:errors -->'],
  ['Historical-Rejected-Approaches', '<!-- swe:rejected -->'],
  ['Files-Read / Files-Modified', '<!-- swe:files -->'],
  ['Operating-Facts', '<!-- swe:facts -->'],
  ['In-Flight Side Effects', '<!-- swe:effects -->'],
  ['Pending-Gates', '<!-- swe:gates -->'],
  ['Claimed-Rows', '<!-- swe:rows -->'],
].map(([heading, anchor], i) => ({ key: keys[i], heading, anchor }));
const coreHeadings = pluginHeadings.map((s) => s.key === 'errors' ? { ...s, heading: 'Historical-Errors → Resolutions' } : s);
const keyAnchors = (sections) => sections.map(({ key, anchor }) => ({ key, anchor }));
const sectionPatterns = (sections) => sections.map(({ key, title, anchor, headingPattern, maxDepth }) => ({ key, title: title.replace(/→/g, '->'), anchor, headingPattern, maxDepth }));

test('section parity accepts arrow glyphs but rejects a one-sided title edit', () => {
  assert.deepEqual(sectionPatterns(plugin.CAPSULE_SECTIONS), sectionPatterns(core.CAPSULE_SECTIONS));
  for (const entry of plugin.CAPSULE_SECTIONS) {
    const edited = plugin.CAPSULE_SECTIONS.map((s) => s === entry ? { ...s, title: s.title + ' edited' } : s);
    assert.notDeepEqual(sectionPatterns(edited), sectionPatterns(core.CAPSULE_SECTIONS), entry.key);
  }
});

test('section matchers are precompiled once and share heading pattern sources', () => {
  for (const mod of [core, plugin]) {
    for (const entry of mod.CAPSULE_SECTIONS) {
      assert.ok(entry.heading instanceof RegExp, entry.key);
      assert.equal(entry.heading.source, new RegExp(entry.headingPattern, 'i').source);
      assert.equal(entry.heading.flags, 'i');
    }
  }
  assert.deepEqual(core.CAPSULE_SECTIONS.map(({ heading }) => heading.source),
    plugin.CAPSULE_SECTIONS.map(({ heading }) => heading.source));
  assert.doesNotMatch(core.locateCapsuleSection.toString(), /new RegExp/);
  const matcher = core.CAPSULE_SECTIONS.find(({ key }) => key === 'gates').heading;
  for (let i = 0; i < 3; i++) {
    assert.ok(core.locateCapsuleSection('### Pending-Gates\n- pending', 'gates'));
    assert.equal(core.locateCapsuleSection('#### Pending-Gates\n- pending', 'gates'), null);
  }
  assert.equal(core.CAPSULE_SECTIONS.find(({ key }) => key === 'gates').heading, matcher);
});

test('regression: section maxDepth is shared and legacy locator finds level-three gates', () => {
  for (const mod of [core, plugin]) {
    assert.equal(mod.CAPSULE_SECTIONS.find((s) => s.key === 'gates').maxDepth, 3);
    assert.equal(mod.CAPSULE_SECTIONS.find((s) => s.key === 'effects').maxDepth, 3);
    assert.ok(mod.CAPSULE_SECTIONS.every((s) => Number.isInteger(s.maxDepth)));
  }
  assert.deepEqual(core.CAPSULE_SECTIONS.map(({ key, maxDepth }) => ({ key, maxDepth })),
    plugin.CAPSULE_SECTIONS.map(({ key, maxDepth }) => ({ key, maxDepth })));
  const gates = core.CAPSULE_SECTIONS.find((s) => s.key === 'gates');
  for (const anchor of ['', gates.anchor + '\n']) {
    const doc = `### Pending-Gates\n${anchor}- pending\n### Next\n- excluded`;
    const found = core.locateCapsuleSection(doc, gates.anchor, gates.headingPattern);
    assert.ok(found);
    assert.deepEqual(found, core.locateCapsuleSection(doc, gates));
    assert.match(doc.slice(found.start, found.end), /pending/);
    assert.doesNotMatch(doc.slice(found.start, found.end), /excluded/);
  }
});

test('ownership amended: frozen section copies share exact keys anchors and effects heading', () => {
  assert.deepEqual(keyAnchors(core.CAPSULE_SECTIONS), keyAnchors(pluginHeadings));
  assert.deepEqual(sectionPatterns(plugin.CAPSULE_SECTIONS), sectionPatterns(core.CAPSULE_SECTIONS));
  assert.deepEqual(plugin.CAPSULE_SECTIONS.find((s) => s.key === 'effects'), core.CAPSULE_SECTIONS.find((s) => s.key === 'effects'));
  assert.notEqual(plugin.CAPSULE_SECTIONS, core.CAPSULE_SECTIONS);
  for (const mod of [core, plugin]) {
    assert.ok(Object.isFrozen(mod.CAPSULE_SECTIONS));
    assert.ok(mod.CAPSULE_SECTIONS.every(Object.isFrozen));
    assert.deepEqual(keyAnchors(mod.CAPSULE_SECTIONS), keyAnchors(pluginHeadings));
  }
  assert.doesNotMatch(source('daemons/lifecycle-common.mjs'), /from\s+['"][^'"]*plugins\//);
});

for (const renderer of ['writer', 'plugin']) {
  test(`${renderer}: all original headings and eight anchors render from keyed sections`, (t) => {
    const doc = renderer === 'writer' ? fixture(t).write([user('Review export')])
      : buildCapsule({ id: 'test', objective: 'Review export', waitingOn: 'Check', nextAction: 'Inspect' });
    const expected = renderer === 'writer' ? coreHeadings : pluginHeadings;
    assert.deepEqual([...doc.matchAll(/^## (.+)\n(<!-- swe:[a-z]+ -->)$/gm)].map((m) => m.slice(1)), expected.map(({ heading, anchor }) => [heading, anchor]));
  });
}

test('reversal: installer and isolated test trees need no plugin-copy helper', () => {
  assert.doesNotMatch(source('install.sh'), /plugins\/context-capsule\/scripts/);
  assert.equal(existsSync(new URL('./helpers/capsule-format.mjs', import.meta.url)), false);
  for (const file of ['semantic-search-deny', 'semantic-search-namespace-registry', 'semantic-search-supersession',
    'stop-capsule-writer', 'stop-writer.receipt-identity', 'persisted-render', 'precompact-flush']) {
    assert.doesNotMatch(source(`daemons/tests/${file}.test.mjs`), /copyCapsuleFormat|helpers\/capsule-format/);
  }
});
