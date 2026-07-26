#!/usr/bin/env node
// Deterministic seven-calendar-day attention reconciliation.

import {
  existsSync, readFileSync, readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultNightlyRoot, resolveNightlyPaths,
} from './nightly-paths.mjs';

const DAY_MS = 86_400_000;

function addDays(date, delta) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + delta * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function parseIntendedShares(text) {
  const projects = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    let match = line.match(
      /^\|[ \t]*1[ \t]*\|[ \t]*(?:\[\[)?([^\]|]+)(?:\|[^\]]+)?(?:\]\])?[ \t]*\|[ \t]*(\d{1,3})%[ \t]*\|/i,
    );
    if (!match) {
      match = line.match(
        /^Tier[ \t]+1[ \t]+[—-][ \t]+(?:\[\[)?([^\]|]+)(?:\|[^\]]+)?(?:\]\])?[ \t]+[—-][ \t]+intended[ \t]+(\d{1,3})%/i,
      );
    }
    if (!match) continue;
    const name = match[1].trim();
    const intended = Number(match[2]);
    if (intended < 1 || intended > 100) {
      throw new Error(`RECONCILE FAIL reason=invalid-intended-share project=${name}`);
    }
    if (projects.has(name.toLowerCase())) {
      throw new Error(`RECONCILE FAIL reason=duplicate-project project=${name}`);
    }
    projects.set(name.toLowerCase(), { name, intended });
  }
  if (!projects.size) {
    throw new Error('RECONCILE FAIL reason=intended-share-input-absent projects=0');
  }
  const total = [...projects.values()]
    .reduce((sum, project) => sum + project.intended, 0);
  if (total > 100) throw new Error(`RECONCILE FAIL reason=intended-share-total total=${total}`);
  return [...projects.values()];
}

function escaped(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizedTarget(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '')
    .trim()
    .toLowerCase();
}

function noteAliases(file, vaultRoot) {
  const relative = path.relative(vaultRoot, file).replace(/\\/g, '/').replace(/\.md$/i, '');
  const base = path.basename(file, '.md');
  const aliases = new Set([relative, base]);
  const text = readFileSync(file, 'utf8');
  const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatter) {
    let inAliases = false;
    for (const line of frontmatter[1].split(/\r?\n/)) {
      if (/^aliases:[ \t]*$/i.test(line)) {
        inAliases = true;
        continue;
      }
      const item = inAliases ? line.match(/^[ \t]+-[ \t]+(.+?)\s*$/) : null;
      if (item) aliases.add(item[1].replace(/^["']|["']$/g, '').trim());
      else if (inAliases && /^\S/.test(line)) inAliases = false;
    }
  }
  return [...aliases];
}

function projectIndexFromRoot(vaultRoot) {
  const projectsRoot = path.join(vaultRoot, 'projects');
  const index = new Map();
  if (!existsSync(projectsRoot)) return index;
  const pending = [projectsRoot];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const canonical = path.relative(vaultRoot, target)
          .replace(/\\/g, '/')
          .replace(/\.md$/i, '');
        for (const alias of noteAliases(target, vaultRoot)) {
          index.set(normalizedTarget(alias), canonical);
        }
      }
    }
  }
  return index;
}

function suppliedProjectIndex(projectNotes) {
  if (projectNotes instanceof Map) {
    return new Map(
      [...projectNotes]
        .map(([alias, canonical]) => [normalizedTarget(alias), String(canonical)]),
    );
  }
  const index = new Map();
  for (const note of projectNotes || []) {
    const canonical = String(note).replace(/\\/g, '/').replace(/\.md$/i, '');
    index.set(normalizedTarget(canonical), canonical);
    index.set(normalizedTarget(path.basename(canonical)), canonical);
  }
  return index;
}

function containsPlainName(text, name) {
  return new RegExp(
    `(?:^|[^A-Za-z0-9])${escaped(name)}(?:$|[^A-Za-z0-9])`,
    'i',
  ).test(text);
}

function scoreNote(text, projects, projectIndex) {
  const scores = new Map(projects.map((project) => [project.name, 0]));
  const tierAliases = new Map();
  for (const project of projects) {
    tierAliases.set(normalizedTarget(project.name), project.name);
    const canonical = projectIndex.get(normalizedTarget(project.name));
    if (canonical) {
      for (const [alias, target] of projectIndex) {
        if (target === canonical) tierAliases.set(alias, project.name);
      }
    }
  }
  const nonTierScores = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const heading = /^#{1,6}[ \t]+/.test(line);
    const links = [...line.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)];
    let residual = line;
    for (const link of links) {
      const target = link[1].trim();
      const points = heading ? 3 : 2;
      const tierName = tierAliases.get(normalizedTarget(target));
      if (tierName) scores.set(tierName, Math.max(scores.get(tierName), points));
      else {
        const canonical = projectIndex.get(normalizedTarget(target));
        if (canonical) {
          nonTierScores.set(canonical, Math.max(nonTierScores.get(canonical) || 0, points));
        }
      }
      residual = residual.replace(link[0], ' ');
    }
    for (const project of projects) {
      if (containsPlainName(residual, project.name)) {
        scores.set(project.name, Math.max(scores.get(project.name), heading ? 3 : 1));
      }
    }
  }
  return {
    scores,
    nonTier: [...nonTierScores.values()].reduce((sum, points) => sum + points, 0),
  };
}

export function reconcileAttention({
  prioritiesText,
  dailyNotes,
  asOf,
  projectNotes = [],
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf || ''))) {
    throw new Error('RECONCILE FAIL reason=invalid-as-of');
  }
  const parsedAsOf = new Date(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(parsedAsOf.getTime())
      || parsedAsOf.toISOString().slice(0, 10) !== asOf) {
    throw new Error('RECONCILE FAIL reason=invalid-as-of');
  }
  const projects = parseIntendedShares(prioritiesText);
  const projectIndex = suppliedProjectIndex(projectNotes);
  const start = addDays(asOf, -6);
  const totals = new Map(projects.map((project) => [project.name, 0]));
  let nonTier = 0;
  const selected = Object.entries(dailyNotes || {})
    .filter(([date]) => date >= start && date <= asOf)
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [, text] of selected) {
    const scored = scoreNote(text, projects, projectIndex);
    for (const [name, points] of scored.scores) totals.set(name, totals.get(name) + points);
    nonTier += scored.nonTier;
  }
  const denominator = [...totals.values()].reduce((sum, value) => sum + value, 0) + nonTier;
  if (!denominator) {
    throw new Error('RECONCILE FAIL reason=no-measurable-project-attention');
  }
  const rows = projects.map((project) => {
    const points = totals.get(project.name);
    const actual = Math.round((points / denominator) * 1000) / 10;
    const threshold = Math.round(project.intended * 0.4 * 10) / 10;
    return {
      ...project,
      points,
      actual,
      threshold,
      drift: actual < threshold,
    };
  });
  const nonTierActual = Math.round((nonTier / denominator) * 1000) / 10;
  const lines = [
    `RECONCILE PASS window=${start}..${asOf} notes=${selected.length}`,
    `sources=${selected.length
      ? selected.map(([date]) => `daily/${date}.md`).join(',')
      : 'none'}`,
    ...rows.map((row) => (
      `project=${row.name} points=${row.points}`
      + ` actual=${row.actual.toFixed(1)}% intended=${row.intended}%`
      + ` threshold=${row.threshold.toFixed(1)}% drift=${row.drift ? 'yes' : 'no'}`
    )),
    `non_tier_1 points=${nonTier} actual=${nonTierActual.toFixed(1)}%`
      + ` drift=${nonTierActual > 25 ? 'yes' : 'no'}`,
  ];
  return {
    ok: true,
    window: { start, end: asOf },
    notes: selected.map(([date]) => date),
    rows,
    nonTier: {
      points: nonTier,
      actual: nonTierActual,
      drift: nonTierActual > 25,
    },
    output: lines.join('\n'),
  };
}

const direct = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (direct) {
  const rootIndex = process.argv.indexOf('--root');
  const dateIndex = process.argv.indexOf('--as-of');
  const root = path.resolve(
    rootIndex >= 0 ? process.argv[rootIndex + 1] : defaultNightlyRoot(),
  );
  const asOf = dateIndex >= 0 ? process.argv[dateIndex + 1] : '';
  try {
    const paths = resolveNightlyPaths(root);
    const dailyRoot = path.join(paths.vaultRoot, 'daily');
    const dailyNotes = {};
    if (existsSync(dailyRoot)) {
      for (const name of readdirSync(dailyRoot)) {
        const match = name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
        if (match) dailyNotes[match[1]] = readFileSync(path.join(dailyRoot, name), 'utf8');
      }
    }
    const result = reconcileAttention({
      prioritiesText: readFileSync(path.join(paths.memoryRoot, 'ACTIVE_PRIORITIES.md'), 'utf8'),
      dailyNotes,
      asOf,
      projectNotes: projectIndexFromRoot(paths.vaultRoot),
    });
    process.stdout.write(result.output + '\n');
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${String(error?.message || error).replace(/[\r\n]+/g, ' ')}\n`);
    process.exit(1);
  }
}
