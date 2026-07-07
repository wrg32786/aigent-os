/**
 * search-vault.js
 * Semantic search over the Obsidian vault embedding index.
 * Runs the query embedding locally — no API calls.
 *
 * Usage:
 *   node search-vault.js "what did we decide about audio routing"
 *   node search-vault.js "what did we decide about the marketing strategy" --top 10
 *   node search-vault.js "audio routing" --json   # JSON only output
 */

import { pipeline } from '@xenova/transformers';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Config ──────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AIGENT_ROOT = process.env.AIGENT_ROOT || join(__dirname, '..', '..');
const VAULT_ROOT = process.env.AIGENT_VAULT_ROOT || join(AIGENT_ROOT, 'vault');
const EMBEDDINGS_PATH = join(VAULT_ROOT, 'memory', 'embeddings.json');
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_TOP_K = 5;

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
  // Load index
  if (!existsSync(EMBEDDINGS_PATH)) {
    console.error(`Embeddings index not found at ${EMBEDDINGS_PATH}`);
    console.error('Run: node embed-vault.js');
    process.exit(1);
  }

  if (!jsonOnly) process.stdout.write('Loading index... ');
  const raw = readFileSync(EMBEDDINGS_PATH, 'utf8');
  const index = JSON.parse(raw);
  if (!jsonOnly) console.log(`${index.notes.length} entries loaded.`);

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

  // Deduplicate by file path — keep best-scoring chunk per file
  const seen = new Set();
  const results = [];
  for (const r of scored) {
    if (!seen.has(r.path)) {
      seen.add(r.path);
      results.push(r);
    }
    if (results.length >= topK) break;
  }

  const searchTime = Date.now() - t1;

  // Output
  const jsonOut = results.map(r => ({
    path: r.path,
    title: r.title,
    score: parseFloat(r.score.toFixed(4)),
    chunk: r.chunk,
    ...(r.chunkIndex != null ? { chunkIndex: r.chunkIndex, chunkCount: r.chunkCount } : {}),
  }));

  if (jsonOnly) {
    console.log(JSON.stringify(jsonOut, null, 2));
    return;
  }

  // Human-readable output
  console.log('─'.repeat(60));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const chunkInfo = r.chunkIndex != null ? ` (chunk ${r.chunkIndex + 1}/${r.chunkCount})` : '';
    console.log(`${i + 1}. [${(r.score * 100).toFixed(1)}%] ${r.title}${chunkInfo}`);
    console.log(`   Path: ${r.path}`);
    if (r.tags && r.tags.length > 0) {
      console.log(`   Tags: ${r.tags.join(', ')}`);
    }
    console.log(`   Preview: ${r.chunk.slice(0, 200).replace(/\n/g, ' ').trim()}...`);
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
