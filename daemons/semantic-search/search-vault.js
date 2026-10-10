/**
 * search-vault.js
 * Semantic search over the Obsidian vault embedding index.
 * Runs the query embedding locally — no API calls.
 *
 * Usage:
 *   node search-vault.js "what did we decide about audio routing"
 *   node search-vault.js "what did we decide about the marketing strategy" --top 10
 *   node search-vault.js "audio routing" --json   # JSON only output
 *
 * Trust boundary (issue #43): a note chunk is persisted, operator- or
 * agent-written text, never the current instruction. Both the human preview
 * line and the JSON `chunk` field render through lifecycle-common.mjs's
 * renderPersisted(): single-line, quoted, bounded, tagged with source path /
 * content hash / acquisition time, gated on the row's namespace disposition.
 * `chunk` keeps its field name (nothing else in this repo parses it) but its
 * VALUE changed shape: previously the raw, unbounded chunk text; now the
 * tagged provenance line (`[persisted-data:vault-chunk <path> sha <hash> @
 * <iso>] "<bounded text>"`). A new `chunkProvenance` field carries the same
 * data as discrete fields for a consumer that wants them without parsing the
 * tag. A chunk whose disposition is not renderable (DENY/SKIP/malformed) now
 * renders as `[REFUSED: <reason>]` instead of any text at all -- this is a
 * second, independent gate behind the namespace filter already applied to
 * index.notes below.
 */

import { pipeline } from '@xenova/transformers';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { requireDenyPrefixes, deniedPath } from './deny-list.mjs';
import {
  namespaceDispositionForPath,
  requireDeclaredNamespaceDirectories,
  requireNamespaceRegistry,
} from './namespace-registry.mjs';
import { inert, renderPersisted } from '../lifecycle-common.mjs';
import { FRAMING_LINES } from '../memory-hygiene/resume-framing.mjs';
import { resolveMemoryRoot } from '../memory-root.cjs';

// ── Config ──────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AIGENT_ROOT = process.env.AIGENT_ROOT || join(__dirname, '..', '..');
const VAULT_ROOT = process.env.AIGENT_VAULT_ROOT || join(AIGENT_ROOT, 'vault');
// Same resolver, same tree as the indexer and every hook.
const EMBEDDINGS_PATH = join(resolveMemoryRoot(process.env.AIGENT_STATE_HOME_DIR || AIGENT_ROOT), 'embeddings.json');
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_TOP_K = 5;

// Missing or invalid namespace policy must stop the process before an index is
// read or any result can be emitted.
const NAMESPACE_REGISTRY = requireNamespaceRegistry(__dirname, 'search-vault');

// Confidential-class deny list, re-checked at query time so this is safe even
// against a stale or hand-edited embeddings.json built before a prefix was added
// (or built by a version of embed-vault.js run without its own filter). A deny
// file that exists but cannot be parsed returns no results at all, never
// "results minus the deny list"; no deny file at all is the fresh-install
// default and searches everything (see deny-list.mjs).
const DENY_PREFIXES = requireDenyPrefixes(__dirname, 'search-vault');

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const topIdx = args.indexOf('--top');
const topK = topIdx !== -1 ? parseInt(args[topIdx + 1], 10) || DEFAULT_TOP_K : DEFAULT_TOP_K;
// Skip flags and the value after --top
const skipValues = new Set();
if (topIdx !== -1) skipValues.add(args[topIdx + 1]);
const query = args.filter(a => !a.startsWith('--') && !skipValues.has(a)).join(' ').trim();

if (!query) {
  console.error('Usage: node search-vault.js "your query here" [--top N] [--json]');
  process.exit(1);
}

// ── Cosine similarity ────────────────────────────────────────────────────────
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Temporal supersession ────────────────────────────────────────────────────
// A note may carry a validity window in its BODY, in the form
// `Valid from <YYYY-MM-DD>` or `Valid from <YYYY-MM-DD> to <YYYY-MM-DD>`. The
// line lives in the body rather than in frontmatter because embed-vault.js:294
// stores a slice of the raw body as the chunk, so a frontmatter-only date could
// never reach a returned row. A CLOSED window whose end date has passed marks a
// superseded note: still true as history, but it must not outrank a note that
// still governs.
//
// Superseded rows are DEMOTED below every non-superseded row, never dropped, so
// a query that nothing current answers can still reach the historical rule. The
// demotion runs after the deny and namespace filters below and before the
// dedupe-and-truncate, so a demoted row genuinely leaves the top K rather than
// being reordered inside it, and both output sites are fed from that one order.
//
// Three deliberate non-behaviours:
//   - a row with no validity line is untouched: this is opt-in note metadata,
//     not a schema every note must satisfy;
//   - an OPEN window is current by construction and is never demoted;
//   - a validity line whose dates do not parse is REPORTED on stderr and left
//     exactly where cosine put it. A date this file cannot read must never
//     silently change a ranking.
//
// Expiry is a property of the NOTE, not of one chunk: a long note's later
// chunks carry no validity line, so the ended windows are collected per path
// first and then applied to every chunk of that path.
//
// AIGENT_SEARCH_DISABLE_SUPERSESSION=1 turns the demotion off. It exists so a
// test can witness that the demotion, and not something else, is what moved a
// row (daemons/tests/semantic-search-supersession.test.mjs).
const SUPERSESSION_OFF = process.env.AIGENT_SEARCH_DISABLE_SUPERSESSION === '1';
const VALIDITY_LINE = /^Valid from (.+?)\s*$/m;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
// AIGENT_SEARCH_NOW=<ISO instant> pins the clock the demotion compares against.
// Test-only: it lets a suite witness the end-of-day boundary and the UTC
// anchoring on fixed dates instead of waiting for the calendar. Unset in
// production, and an unreadable value is refused rather than ignored.
const NOW_OVERRIDE = process.env.AIGENT_SEARCH_NOW;
if (NOW_OVERRIDE !== undefined && Number.isNaN(Date.parse(NOW_OVERRIDE))) {
  console.error(`search-vault: AIGENT_SEARCH_NOW is not an ISO instant: ${inert(NOW_OVERRIDE, 80)}`);
  process.exit(1);
}
const nowMs = () => (NOW_OVERRIDE !== undefined ? Date.parse(NOW_OVERRIDE) : Date.now());

// A calendar day is readable only if it has the ISO shape AND names a day that
// exists: Date.parse('2026-02-30T...') silently yields March 2, so the shape
// check alone would let an impossible date change a ranking. Round-tripping
// through toISOString refuses it.
function isoDay(s) {
  if (!ISO_DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function endedWindowPaths(rows, nowMs) {
  const ended = new Set();
  for (const r of rows) {
    const m = typeof r.chunk === 'string' ? r.chunk.match(VALIDITY_LINE) : null;
    if (!m) continue;
    const parts = m[1].split(' to ');
    if (parts.length === 1) continue; // open window: still current
    const from = String(parts[0]).trim();
    const to = String(parts[1]).trim();
    // Dates are read as whole UTC days, so a window ends at the last instant of
    // its end date and the comparison does not depend on the reader's timezone.
    const end = parts.length === 2 && isoDay(from) && isoDay(to)
      ? Date.parse(`${to}T23:59:59.999Z`)
      : NaN;
    if (Number.isNaN(end)) {
      console.error(`search-vault: unreadable validity line in ${inert(r.path, 200)}: ${inert(m[0], 120)} (rank left unchanged)`);
      continue;
    }
    if (nowMs > end) ended.add(r.path);
  }
  return ended;
}

function demoteSuperseded(rows, nowMs) {
  if (SUPERSESSION_OFF) return rows;
  const ended = endedWindowPaths(rows, nowMs);
  if (ended.size === 0) return rows;
  // Array.prototype.sort is stable, so keying only on the ended flag preserves
  // the descending cosine order inside each of the two groups.
  return rows.slice().sort((a, b) => (ended.has(a.path) ? 1 : 0) - (ended.has(b.path) ? 1 : 0));
}

// ── Honest abstention ────────────────────────────────────────────────────────
// When nothing the filters left reaches the relevance floor, the honest answer
// is "I have nothing", not five unrelated rows. The results stay an array (`[]`)
// and the reason rides ONE stderr line, never inside the array:
//   AIGENT_ABSTAIN {"schema":"abstain/1","invocation":"<token>","outcome":"abstain","reason":"<reason>"}
// reason: `no-eligible-candidates` when the deny and namespace filters left no
// row at all; `below-tau` when every remaining row scores under the floor.
// The decision runs only after the index loaded and BOTH filters ran, so a
// missing or malformed index, a namespace refusal or a bad deny file keeps its
// own non-zero exit and is never relabelled as an abstention.
//
// The floor is 0.30 on the score as emitted (4 decimals), the abstain floor
// frozen at recollection-44 PREREG-001 3.2 from the model's general calibration,
// with no measurement of any corpus. It is not tunable here on purpose.
//
// The token is echoed exactly as given (AIGENT_SEARCH_INVOCATION, '' if unset),
// never invented: a caller that binds the line to its own invocation can tell a
// missing or wrong token apart from a real one.
const ABSTAIN_TAU = 0.30;
function abstentionReason(sortedRows) {
  if (sortedRows.length === 0) return 'no-eligible-candidates';
  return parseFloat(sortedRows[0].score.toFixed(4)) < ABSTAIN_TAU ? 'below-tau' : null;
}

// ── Embed query ──────────────────────────────────────────────────────────────
let embedder = null;

async function embedText(text) {
  if (!embedder) {
    if (!jsonOnly) console.log(`Loading model: ${MODEL_NAME}...`);
    embedder = await pipeline('feature-extraction', MODEL_NAME, { quantized: true });
  }
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Search refuses the same undeclared physical state as index construction.
  // This is independent of the stale-entry filter below: a live namespace must
  // be classified before either caller will operate.
  requireDeclaredNamespaceDirectories(NAMESPACE_REGISTRY, VAULT_ROOT, 'search-vault');

  // Load index
  if (!existsSync(EMBEDDINGS_PATH)) {
    console.error(`Embeddings index not found at ${EMBEDDINGS_PATH}`);
    console.error('Run: node embed-vault.js');
    process.exit(1);
  }

  if (!jsonOnly) process.stdout.write('Loading index... ');
  const raw = readFileSync(EMBEDDINGS_PATH, 'utf8');
  const index = JSON.parse(raw);
  const beforeDeny = index.notes.length;
  index.notes = index.notes.filter((n) => !deniedPath(DENY_PREFIXES, n.path));
  const deniedCount = beforeDeny - index.notes.length;
  const beforeNamespace = index.notes.length;
  index.notes = index.notes.filter((note) => namespaceDispositionForPath(NAMESPACE_REGISTRY, note.path) === 'INDEX');
  const namespaceCount = beforeNamespace - index.notes.length;
  if (!jsonOnly) {
    console.log(`${index.notes.length} entries loaded.${deniedCount ? ` (${deniedCount} confidential-class chunk(s) filtered by index-deny.json)` : ''}${namespaceCount ? ` (${namespaceCount} non-INDEX namespace chunk(s) filtered by namespace-registry.json)` : ''}`);
  }

  // Embed query
  const t0 = Date.now();
  if (!jsonOnly) console.log(`\nQuery: "${query}"\n`);
  const queryVec = await embedText(query);
  const embedTime = Date.now() - t0;

  // Score all entries
  const t1 = Date.now();
  const scored = index.notes.map(note => ({
    path: note.path,
    title: note.title,
    tags: note.tags || [],
    chunkIndex: note.chunkIndex,
    chunkCount: note.chunkCount,
    chunk: note.chunk,
    score: cosineSimilarity(queryVec, note.embedding),
  }));

  // Sort descending
  scored.sort((a, b) => b.score - a.score);
  const abstention = abstentionReason(scored);

  // Demote every chunk whose validity window has ended below every chunk whose
  // has not. Placed here, between the sort and the truncation below, so a
  // demoted row leaves the top K instead of being reordered inside it.
  const ranked = demoteSuperseded(scored, nowMs());

  // Deduplicate by file path — keep best-scoring chunk per file
  const seen = new Set();
  const results = [];
  for (const r of ranked) {
    if (!seen.has(r.path)) {
      seen.add(r.path);
      results.push(r);
    }
    if (results.length >= topK) break;
  }
  if (abstention) results.length = 0;

  const searchTime = Date.now() - t1;
  if (abstention) {
    console.error(`AIGENT_ABSTAIN ${JSON.stringify({ schema: 'abstain/1', invocation: process.env.AIGENT_SEARCH_INVOCATION ?? '', outcome: 'abstain', reason: abstention })}`);
  }

  // Output. Every result's chunk renders through the trust-boundary
  // chokepoint exactly once, reused for both the JSON and human sites -- see
  // the header comment above for why the disposition is re-derived here
  // rather than trusted from the earlier index.notes filter.
  const rendered = results.map((r) => {
    const disposition = namespaceDispositionForPath(NAMESPACE_REGISTRY, r.path);
    return { r, persisted: renderPersisted({ path: r.path, text: r.chunk, role: 'vault-chunk', disposition, max: 500 }) };
  });

  const jsonOut = rendered.map(({ r, persisted }) => ({
    path: r.path,
    title: r.title,
    score: parseFloat(r.score.toFixed(4)),
    chunk: persisted.refused ? `[REFUSED: ${persisted.refused}]` : persisted.line,
    chunkProvenance: persisted.refused ? { refused: persisted.refused } : persisted.record,
    ...(r.chunkIndex != null ? { chunkIndex: r.chunkIndex, chunkCount: r.chunkCount } : {}),
  }));

  if (jsonOnly) {
    console.log(JSON.stringify(jsonOut, null, 2));
    return;
  }

  // Human-readable output
  console.log('─'.repeat(60));
  console.log(FRAMING_LINES[0]);
  console.log();
  if (abstention) console.log(`No result reached the relevance floor (${abstention}).\n`);
  for (let i = 0; i < rendered.length; i++) {
    const { r, persisted } = rendered[i];
    // title/path/tags/chunkIndex/chunkCount are the same persisted, same
    // trust-class fields as chunk (all come off the same embeddings.json note
    // object) -- each goes through inert() here too, or a raw sibling field
    // can forge a whole extra result line (review R1, finding F3).
    const chunkInfo = r.chunkIndex != null ? ` (chunk ${Number(r.chunkIndex) + 1}/${Number(r.chunkCount)})` : '';
    console.log(`${i + 1}. [${(r.score * 100).toFixed(1)}%] ${inert(r.title, 120)}${chunkInfo}`);
    console.log(`   Path: ${inert(r.path, 200)}`);
    if (r.tags && r.tags.length > 0) {
      console.log(`   Tags: ${r.tags.map((t) => inert(t, 60)).join(', ')}`);
    }
    console.log(`   Preview: ${persisted.refused ? `[REFUSED: ${persisted.refused}]` : persisted.line}`);
    console.log();
  }
  console.log('─'.repeat(60));
  console.log(`Embed: ${embedTime}ms | Search: ${searchTime}ms | Total: ${embedTime + searchTime}ms`);
  console.log(`Index: ${index.entryCount || index.notes.length} entries, updated ${index.updated || 'unknown'}`);

  // Also print JSON for programmatic consumption
  console.log('\nJSON:');
  console.log(JSON.stringify(jsonOut, null, 2));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
