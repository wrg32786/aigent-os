#!/usr/bin/env node
/**
 * Memory Heat — computes per-note heat_score for the aigent-OS vault.
 *
 * Pattern ported from tinyhumansai/neocortex: notes decay if unused, reinforce if touched.
 * See vault/concepts/Memory Decay Doctrine.md for full doctrine.
 *
 * Inputs:
 *   - Vault notes (*.md files under VAULT_ROOT, excluding daily/ and configured ignores)
 *   - Session reads from Claude Code JSONL logs (optional; fallback degrades gracefully)
 *   - Backlink counts (grep for [[note-name]] across vault)
 *   - File mtimes
 *   - daemons/memory-heat/pinlist.json (optional) — paths that never decay below PIN_FLOOR
 *
 * Output: vault/memory/HEAT_INDEX.json
 *
 * Usage:
 *   node daemons/memory-heat/compute-heat.js
 *
 * Environment variables (optional):
 *   AIGENT_VAULT_ROOT — absolute path to vault root (default: two dirs up from this file)
 *   AIGENT_JSONL_ROOT — absolute path to Claude Code project logs (default: skip session read signal)
 */

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;

// Path convention (matches daemons/semantic-search/embed-vault.js):
//   AIGENT_ROOT  — root of the aigent-os repo (or install dir).  Default: two dirs up from this file.
//   VAULT_ROOT  — root of the Obsidian vault.                  Default: AIGENT_ROOT/vault
//
// All scored note paths are VAULT-RELATIVE (e.g. "concepts/Foo.md").
// Session-read paths from JSONL are absolute; we strip VAULT_ROOT to normalize them to the same form.
// Never mix repo-relative and vault-relative — that mismatch is what caused the "reads never match" bug.
const AIGENT_ROOT = process.env.AIGENT_ROOT || path.resolve(SCRIPT_DIR, '..', '..');
const VAULT_ROOT = process.env.AIGENT_VAULT_ROOT || path.join(AIGENT_ROOT, 'vault');
const JSONL_ROOT = process.env.AIGENT_JSONL_ROOT || null;

const OUTPUT = path.join(VAULT_ROOT, 'memory', 'HEAT_INDEX.json');
const PINLIST_FILE = path.join(SCRIPT_DIR, 'pinlist.json');

const WEIGHTS = {
  session_reads: 0.40,
  backlinks: 0.25,
  mtime_recency: 0.20,
  pin_override: 0.15,
};

const HALF_LIFE_DAYS = 60;
const LOOKBACK_DAYS = 30;
const PIN_FLOOR = 50;

const EXCLUDE_DIRS = new Set([
  '.obsidian',
  '.claude',
  '.git',
  'daily',
  'node_modules',
  'daemons',
  'hooks',
  'system',
  'docs',
  'assets',
  'skills',
  'tools',            // Python venvs and shell scripts — not vault notes
]);

const EXCLUDE_FILES = new Set([
  'MEMORY.md',
  'HEAT_INDEX.json',
]);

function loadPinList() {
  try {
    const content = fs.readFileSync(PINLIST_FILE, 'utf8');
    const data = JSON.parse(content);
    return new Set(data.pins || []);
  } catch {
    return new Set(); // Graceful fallback — no pins is valid
  }
}

function walkVault(dir, baseDir = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(baseDir, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name) || EXCLUDE_DIRS.has(rel)) continue;
      walkVault(full, baseDir, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      out.push(rel);
    }
  }
  return out;
}

function readFrontmatterPin(absPath) {
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const pinMatch = fmMatch[1].match(/^pin:\s*(.+)$/m);
    return pinMatch ? pinMatch[1].trim() : null;
  } catch {
    return null;
  }
}

function collectSessionReads() {
  const counts = new Map();
  if (!JSONL_ROOT) return counts; // No JSONL root configured — skip session signal

  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  let jsonlFiles = [];
  try {
    jsonlFiles = fs.readdirSync(JSONL_ROOT)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(JSONL_ROOT, f));
  } catch {
    return counts;
  }

  for (const file of jsonlFiles) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;

    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      const toolUse = entry?.message?.content?.find?.(c => c.type === 'tool_use' && c.name === 'Read');
      if (!toolUse) continue;
      const fp = toolUse.input?.file_path;
      if (!fp) continue;
      // Normalize to vault-relative path so it matches scored note paths.
      // Session reads arrive as absolute paths; strip VAULT_ROOT prefix to get vault-relative form.
      const norm = fp.replace(/\\/g, '/');
      const rootNorm = VAULT_ROOT.replace(/\\/g, '/').replace(/\/+$/, '');
      if (!norm.startsWith(rootNorm + '/') && norm !== rootNorm) continue;
      const rel = norm.slice(rootNorm.length).replace(/^\/+/, '');
      counts.set(rel, (counts.get(rel) || 0) + 1);
    }
  }
  return counts;
}

function collectBacklinks(vaultPaths) {
  const nameMap = new Map();
  for (const rel of vaultPaths) {
    const base = path.basename(rel, '.md');
    nameMap.set(base, rel);
    nameMap.set(base.toLowerCase(), rel);
  }

  const backlinkCount = new Map();
  for (const rel of vaultPaths) backlinkCount.set(rel, 0);

  const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

  for (const rel of vaultPaths) {
    const abs = path.join(VAULT_ROOT, rel);
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    let match;
    while ((match = WIKILINK_RE.exec(content)) !== null) {
      const target = match[1].trim();
      const targetPath = nameMap.get(target) || nameMap.get(target.toLowerCase());
      if (targetPath && targetPath !== rel) {
        backlinkCount.set(targetPath, (backlinkCount.get(targetPath) || 0) + 1);
      }
    }
  }
  return backlinkCount;
}

function daysSince(ts) {
  return (Date.now() - ts) / (24 * 60 * 60 * 1000);
}

function normalize01(value, maxValue) {
  if (maxValue <= 0) return 0;
  return Math.min(1, value / maxValue);
}

function decay(daysSinceAccess) {
  return Math.pow(0.5, daysSinceAccess / HALF_LIFE_DAYS);
}

function computeScores(vaultPaths, reads, backlinks, pinList) {
  const maxReads = Math.max(1, ...Array.from(reads.values()));
  const maxBacklinks = Math.max(1, ...Array.from(backlinks.values()));

  const rows = [];
  for (const rel of vaultPaths) {
    const abs = path.join(VAULT_ROOT, rel);
    let mtime = 0;
    try { mtime = fs.statSync(abs).mtimeMs; } catch {}
    const ageDays = daysSince(mtime);
    const mtimeRecency = decay(ageDays);

    const readCount = reads.get(rel) || 0;
    const backlinkCount = backlinks.get(rel) || 0;

    const pin = readFrontmatterPin(abs);
    const isPinCritical = pin === 'critical' || pinList.has(rel);

    const readScore = normalize01(readCount, maxReads);
    const backlinkScore = normalize01(backlinkCount, maxBacklinks);

    const baseScore =
      readScore * WEIGHTS.session_reads +
      backlinkScore * WEIGHTS.backlinks +
      mtimeRecency * WEIGHTS.mtime_recency +
      (isPinCritical ? 1 : 0) * WEIGHTS.pin_override;

    let heat = baseScore * 100;
    if (isPinCritical && heat < PIN_FLOOR) heat = PIN_FLOOR;

    rows.push({
      path: rel,
      heat_score: Math.round(heat * 10) / 10,
      session_reads_30d: readCount,
      backlinks: backlinkCount,
      last_modified: new Date(mtime).toISOString().slice(0, 10),
      age_days: Math.round(ageDays),
      pinned: isPinCritical,
    });
  }

  rows.sort((a, b) => b.heat_score - a.heat_score);
  return rows;
}

function main() {
  console.log(`[memory-heat] aigent-OS root: ${AIGENT_ROOT}`);
  console.log(`[memory-heat] vault root: ${VAULT_ROOT}`);
  console.log('[memory-heat] scanning vault...');
  // walkVault baseDir = VAULT_ROOT so returned paths are vault-relative (e.g. "concepts/Foo.md")
  const vaultPaths = walkVault(VAULT_ROOT);
  console.log(`[memory-heat] ${vaultPaths.length} notes found`);

  console.log('[memory-heat] collecting session reads (JSONL)...');
  const reads = collectSessionReads();
  console.log(`[memory-heat] ${reads.size} distinct paths in session log`);

  console.log('[memory-heat] counting backlinks...');
  const backlinks = collectBacklinks(vaultPaths);

  console.log('[memory-heat] loading pin list...');
  const pinList = loadPinList();
  console.log(`[memory-heat] ${pinList.size} pinned paths`);

  console.log('[memory-heat] computing heat scores...');
  const rows = computeScores(vaultPaths, reads, backlinks, pinList);

  const hotTop20 = rows.slice(0, 20).map(r => r.path);
  const coldBottom20 = rows.slice(-20).reverse().map(r => r.path);

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });

  const out = {
    generated_at: new Date().toISOString(),
    half_life_days: HALF_LIFE_DAYS,
    lookback_days: LOOKBACK_DAYS,
    weights: WEIGHTS,
    total_notes: rows.length,
    hot_top_20: hotTop20,
    cold_bottom_20: coldBottom20,
    notes: rows,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
  console.log(`[memory-heat] wrote ${OUTPUT}`);
  console.log('');
  console.log('Hot top 10:');
  rows.slice(0, 10).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.heat_score.toFixed(1).padStart(5)}  ${r.path}`);
  });
}

main();
