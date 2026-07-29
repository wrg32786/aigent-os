/**
 * embed-vault.js
 * Builds a semantic embedding index of the Obsidian vault.
 * Uses @xenova/transformers to run all-MiniLM-L6-v2 locally — no API calls.
 *
 * Usage:
 *   node embed-vault.js               # full re-index
 *   node embed-vault.js --changed-only  # only re-embed files modified since last run
 */

import { pipeline } from '@xenova/transformers';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, relative, extname, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { requireDenyPrefixes, deniedPath } from './deny-list.mjs';
import frontmatterReader from '../frontmatter-reader.cjs';

const {
  frontmatterList,
  hasFrontmatter,
  scalar,
  unsafeRawDocumentBody,
} = frontmatterReader;

// ── Config ──────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AIGENT_ROOT = process.env.AIGENT_ROOT || join(__dirname, '..', '..');
const VAULT_ROOT = process.env.AIGENT_VAULT_ROOT || join(AIGENT_ROOT, 'vault');
const EMBEDDINGS_PATH = join(VAULT_ROOT, 'memory', 'embeddings.json');
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const MAX_CHUNK_CHARS = 1800; // ~512 tokens at ~3.5 chars/token
const CHUNK_OVERLAP_CHARS = 200;

// Directories to scan (relative to VAULT_ROOT)
const SCAN_DIRS = [
  'daily',
  'memory',
  'concepts',
  'projects',
  'people',
  'agents',
  'research',
  'templates',
];

// Directories/files to skip
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'daemons',
  '.claude',
  'command-center-v2',
  'graphify-out',
  'recon',
  'prompts',
  'tools',
]);

// Confidential-class deny list. Anyone running semantic search over their own
// vault can point it at client work, deal notes, or anything else under NDA, and
// this file writes note text in PLAINTEXT into embeddings.json, so a denied path
// has to be dropped before it is ever embedded. A deny file that exists but
// cannot be parsed refuses to build an index at all rather than risk an
// unfiltered one; no deny file at all is the fresh-install default and indexes
// everything (see deny-list.mjs). search-vault.js re-filters at query time too,
// so a stale or hand-edited embeddings.json can't leak a path this file now
// excludes.
const DENY_PREFIXES = requireDenyPrefixes(__dirname, 'embed-vault');

// ── YAML frontmatter stripper ────────────────────────────────────────────────
function noteContent(content) {
  const frontmatter = hasFrontmatter(content);
  return {
    // AUDIT: semantic embeddings intentionally preserve authored note body
    // paragraphs; title and tags still use the single-line shared readers.
    text: unsafeRawDocumentBody(content, 'semantic indexing preserves authored note body paragraphs'),
    title: frontmatter ? scalar(content, 'title') : null,
    tags: frontmatter ? frontmatterList(content, 'tags') : [],
  };
}

// ── Text chunker ─────────────────────────────────────────────────────────────
function chunkText(text, maxChars = MAX_CHUNK_CHARS, overlap = CHUNK_OVERLAP_CHARS) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxChars;

    // Try to break at paragraph boundary
    if (end < text.length) {
      const paraBreak = text.lastIndexOf('\n\n', end);
      if (paraBreak > start + maxChars / 2) {
        end = paraBreak;
      } else {
        // Try sentence boundary
        const sentBreak = text.lastIndexOf('. ', end);
        if (sentBreak > start + maxChars / 2) {
          end = sentBreak + 1;
        }
      }
    }

    chunks.push(text.slice(start, end).trim());
    start = Math.max(start + 1, end - overlap);
  }

  return chunks.filter(c => c.length > 50); // drop tiny trailing chunks
}

// ── File scanner ─────────────────────────────────────────────────────────────
function scanDirectory(dir, fileList = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return fileList;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      scanDirectory(fullPath, fileList);
    } else if (extname(entry) === '.md') {
      fileList.push({ fullPath, mtime: stat.mtimeMs });
    }
  }

  return fileList;
}

function collectFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const fullDir = join(VAULT_ROOT, dir);
    if (existsSync(fullDir)) {
      scanDirectory(fullDir, files);
    }
  }
  const kept = files.filter((f) => !deniedPath(DENY_PREFIXES, relative(VAULT_ROOT, f.fullPath)));
  const dropped = files.length - kept.length;
  if (dropped > 0) console.log(`[deny] ${dropped} file(s) excluded by index-deny.json`);
  return kept;
}

// ── Embedding pipeline ───────────────────────────────────────────────────────
let embedder = null;
let embedderPromise = null;

async function getEmbedder() {
  if (embedder) return embedder;
  // Use a shared promise so concurrent callers don't each try to load the model
  if (!embedderPromise) {
    embedderPromise = (async () => {
      console.log(`Loading model: ${MODEL_NAME}...`);
      const fn = await pipeline('feature-extraction', MODEL_NAME, {
        quantized: true,
      });
      console.log('Model loaded.');
      embedder = fn;
      return fn;
    })();
  }
  return embedderPromise;
}

async function embedText(text) {
  const fn = await getEmbedder();
  const output = await fn(text, { pooling: 'mean', normalize: true });
  // output.data is a Float32Array
  return Array.from(output.data);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const changedOnly = process.argv.includes('--changed-only');

  // Load existing embeddings if present
  let existing = { model: MODEL_NAME, updated: null, notes: [] };
  if (existsSync(EMBEDDINGS_PATH)) {
    try {
      existing = JSON.parse(readFileSync(EMBEDDINGS_PATH, 'utf8'));
      console.log(`Loaded existing index: ${existing.notes.length} entries`);
    } catch (e) {
      console.warn('Could not parse existing embeddings.json, starting fresh.');
    }
  }

  // Purge denied chunks from the carried-forward index (a --changed-only run must
  // also strip previously-indexed confidential-class entries, not just skip new ones
  // -- a prefix added to index-deny.json after the fact has to retroactively purge).
  const beforePurge = (existing.notes || []).length;
  existing.notes = (existing.notes || []).filter((n) => !deniedPath(DENY_PREFIXES, n.path));
  if (beforePurge !== existing.notes.length) {
    console.log(`[deny] purged ${beforePurge - existing.notes.length} previously-indexed chunk(s) matching index-deny.json`);
  }

  // Build a map of path → existing entries (for --changed-only)
  const existingByPath = new Map();
  for (const note of (existing.notes || [])) {
    const key = note.path + (note.chunkIndex != null ? `::${note.chunkIndex}` : '');
    if (!existingByPath.has(note.path)) existingByPath.set(note.path, []);
    existingByPath.get(note.path).push(note);
  }

  const lastUpdated = existing.updated ? new Date(existing.updated).getTime() : 0;

  // Collect all .md files
  const files = collectFiles();
  console.log(`Found ${files.length} markdown files to consider.`);

  // Determine which files to (re-)embed
  let toEmbed = files;
  if (changedOnly && lastUpdated > 0) {
    toEmbed = files.filter(f => f.mtime > lastUpdated);
    console.log(`--changed-only: ${toEmbed.length} files modified since last index.`);
  }

  if (toEmbed.length === 0) {
    console.log('Nothing to embed. Index is up to date.');
    return;
  }

  // Build new notes array: start with entries NOT being re-embedded
  const pathsToEmbed = new Set(toEmbed.map(f => f.fullPath));
  const keptNotes = (existing.notes || []).filter(n => {
    const absPath = join(VAULT_ROOT, n.path);
    return !pathsToEmbed.has(absPath);
  });

  console.log(`Keeping ${keptNotes.length} unchanged entries, embedding ${toEmbed.length} files...`);

  const newNotes = [];
  let processed = 0;
  const total = toEmbed.length;

  for (const { fullPath, mtime } of toEmbed) {
    const relPath = relative(VAULT_ROOT, fullPath).replace(/\\/g, '/');
    let raw;
    try {
      raw = readFileSync(fullPath, 'utf8');
    } catch (e) {
      console.warn(`  Skipping (unreadable): ${relPath}`);
      continue;
    }

    const { text, title, tags } = noteContent(raw);
    if (text.trim().length < 20) {
      // Skip near-empty files
      continue;
    }

    const derivedTitle = title || basename(fullPath, '.md');
    const chunks = chunkText(text);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        const embedding = await embedText(chunk);
        newNotes.push({
          path: relPath,
          title: derivedTitle,
          tags,
          chunkIndex: chunks.length > 1 ? i : undefined,
          chunkCount: chunks.length > 1 ? chunks.length : undefined,
          chunk: chunk.slice(0, 500),
          embedding,
          mtime,
        });
      } catch (e) {
        console.warn(`  Error embedding ${relPath} chunk ${i}: ${e.message}`);
      }
    }

    processed++;
    if (processed % 10 === 0 || processed === total) {
      process.stdout.write(`\r  Progress: ${processed}/${total} files`);
    }
  }

  console.log(`\nEmbedded ${processed} files, produced ${newNotes.length} entries.`);

  // Merge kept + new
  const finalNotes = [...keptNotes, ...newNotes];

  const output = {
    model: MODEL_NAME,
    updated: new Date().toISOString(),
    noteCount: files.length,
    entryCount: finalNotes.length,
    notes: finalNotes,
  };

  // Ensure memory dir exists
  const memDir = join(VAULT_ROOT, 'memory');
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });

  writeFileSync(EMBEDDINGS_PATH, JSON.stringify(output, null, 0));
  const sizeKB = (readFileSync(EMBEDDINGS_PATH).length / 1024).toFixed(1);
  console.log(`\nSaved embeddings.json — ${finalNotes.length} entries, ${sizeKB} KB`);
  console.log(`Index updated: ${output.updated}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
