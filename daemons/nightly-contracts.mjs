#!/usr/bin/env node
// Executable postconditions for model-mediated nightly work. Validators do not
// synthesize or approve content; they independently decide whether a claimed
// result satisfies its mechanical contract.

import { createHash } from 'node:crypto';
import {
  mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  maskMarkdownFences, newestDatedHeader,
} from './nightly-freshness.mjs';
import {
  defaultNightlyRoot, resolveMemoryRelative, resolveNightlyPaths,
} from './nightly-paths.mjs';

const LESSON_TYPES = new Set([
  'procedural',
  'calibration',
  'strategic',
  'failure-mode',
  'doctrine',
]);

const DREAM_SECTIONS = Object.freeze([
  'Sources reviewed',
  'Lessons extracted',
  'Improvement candidates proposed',
  'Patterns observed',
  'Discarded as one-off',
  'Calibration miscalls',
  'Productive surprises',
  'Open trust-decay items to watch',
]);

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function nonEmptyLines(text) {
  return String(text ?? '').split(/\r?\n/).filter((line) => line.trim());
}

function jsonl(text, label) {
  return nonEmptyLines(text).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} line ${index + 1} invalid JSON: ${error?.message || error}`);
    }
  });
}

function numericId(value, prefix) {
  const match = String(value || '').match(new RegExp(`^${prefix}(\\d+)$`));
  return match ? Number(match[1]) : null;
}

function snapshotJsonl(text, label, idField) {
  const lines = nonEmptyLines(text);
  const rows = jsonl(lines.join('\n'), label);
  return {
    missing: false,
    line_count: lines.length,
    prefix_hash: sha256(lines.join('\n')),
    ids: rows.map((row) => String(row?.[idField] || '')).filter(Boolean),
  };
}

function snapshotSelfModel(text) {
  return {
    missing: false,
    document_hash: sha256(String(text)),
    value: JSON.parse(String(text)),
  };
}

export function captureNightlyContractSnapshot({
  dreamText,
  lessonsText,
  beliefsText,
  proceduresText,
  selfModelText,
} = {}) {
  const missing = (value) => value === null || value === undefined;
  return {
    schema_version: 1,
    dream: missing(dreamText)
      ? { missing: true }
      : {
        missing: false,
        byte_length: Buffer.byteLength(String(dreamText), 'utf8'),
        prefix_hash: sha256(String(dreamText)),
      },
    lessons: missing(lessonsText)
      ? { missing: true }
      : snapshotJsonl(lessonsText, 'LESSONS', 'lesson_id'),
    beliefs: missing(beliefsText)
      ? { missing: true }
      : snapshotJsonl(beliefsText, 'BELIEF_STATE', 'belief_id'),
    procedures: missing(proceduresText)
      ? { missing: true }
      : snapshotJsonl(proceduresText, 'PROCEDURES', 'proc_id'),
    self_model: missing(selfModelText)
      ? { missing: true }
      : snapshotSelfModel(selfModelText),
  };
}

function datedBlock(text, date) {
  const source = String(text ?? '');
  const searchable = maskMarkdownFences(source);
  const headers = [...searchable.matchAll(/^##[ \t]+(\d{4}-\d{2}-\d{2})\b.*$/gm)];
  const index = headers.findLastIndex((header) => header[1] === date);
  if (index < 0) return '';
  return source.slice(headers[index].index, headers[index + 1]?.index ?? source.length);
}

function validateAdmission(row) {
  const refs = [...new Set((row.source_events || []).map(String).filter(Boolean))];
  if (row.admission?.kind === 'two-source') return refs.length >= 2;
  if (row.admission?.kind === 'operator-outcome') {
    const operatorRef = String(row.admission.operator_ref || '').trim();
    const outcomeRef = String(row.admission.outcome_ref || '').trim();
    return Boolean(operatorRef)
      && ((Boolean(outcomeRef) && outcomeRef !== operatorRef)
        || refs.some((ref) => ref !== operatorRef));
  }
  if (row.admission?.kind === 'mechanical-red-green') {
    return Number.isInteger(row.admission.red_exit)
      && row.admission.red_exit !== 0
      && row.admission.green_exit === 0
      && typeof row.admission.artifact_ref === 'string'
      && row.admission.artifact_ref.length > 0;
  }
  return false;
}

function normalizedSectionLine(line) {
  return String(line)
    .replace(/^[ \t]*(?:#{3,6}[ \t]+|[-*+][ \t]+)/, '')
    .replace(/^\*\*/, '')
    .trim();
}

function dreamSectionBodies(block) {
  const lines = String(block).split(/\r?\n/);
  const starts = [];
  for (const [index, line] of lines.entries()) {
    const normalized = normalizedSectionLine(line);
    for (const label of DREAM_SECTIONS) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = normalized.match(
        new RegExp(`^${escaped}(?:\\*\\*)?[ \\t]*:?[ \\t]*(.*)$`, 'i'),
      );
      if (match) {
        starts.push({ index, label, inline: match[1].trim() });
        break;
      }
    }
  }
  const bodies = new Map();
  for (const [position, start] of starts.entries()) {
    const next = starts[position + 1]?.index ?? lines.length;
    const continuation = lines.slice(start.index + 1, next)
      .filter((line) => !/^##[ \t]/.test(line))
      .join('\n')
      .trim();
    bodies.set(
      start.label,
      [start.inline, continuation].filter(Boolean).join('\n').trim(),
    );
  }
  return bodies;
}

function exactStringSet(values) {
  return [...new Set((values || []).map(String))].sort();
}

function sameStringSet(left, right) {
  return JSON.stringify(exactStringSet(left)) === JSON.stringify(exactStringSet(right));
}

function setDifference(left, right) {
  const excluded = new Set((right || []).map(String));
  return exactStringSet(left).filter((value) => !excluded.has(value));
}

function validateJsonlSuffix({
  currentText,
  snapshot,
  label,
  idField,
  prefix,
  allowRevision = false,
  failures,
} = {}) {
  const currentLines = nonEmptyLines(currentText);
  const currentRows = jsonl(currentLines.join('\n'), label);
  if (!snapshot || snapshot.missing || !Number.isInteger(snapshot.line_count)
      || typeof snapshot.prefix_hash !== 'string' || !Array.isArray(snapshot.ids)) {
    failures.push(`${label} trusted pre-pass snapshot missing`);
    return { currentRows, appended: [], allocatedIds: [] };
  }
  if (currentLines.length < snapshot.line_count) {
    failures.push(`${label} is not append-only: line count shrank`);
    return { currentRows, appended: [], allocatedIds: [] };
  }
  const prefixHash = sha256(currentLines.slice(0, snapshot.line_count).join('\n'));
  if (prefixHash !== snapshot.prefix_hash) failures.push(`${label} pre-pass prefix changed`);
  const appended = currentRows.slice(snapshot.line_count);
  const priorIds = new Set(snapshot.ids);
  let next = snapshot.ids.reduce(
    (max, id) => Math.max(max, numericId(id, prefix) || 0),
    0,
  ) + 1;
  const allocatedIds = [];
  const allocated = new Set();
  for (const [index, row] of appended.entries()) {
    const id = String(row?.[idField] || '');
    if (priorIds.has(id)) {
      if (!allowRevision || typeof row.revision_note !== 'string' || !row.revision_note.trim()) {
        failures.push(
          `${label} appended row ${index + 1} reuses ${id || 'missing'} without a revision_note`,
        );
      }
      continue;
    }
    const expected = `${prefix}${String(next).padStart(3, '0')}`;
    if (id !== expected) failures.push(`${label} new id ${id || 'none'} != ${expected}`);
    if (allocated.has(id)) failures.push(`${label} new id collides: ${id}`);
    allocated.add(id);
    allocatedIds.push(id);
    next += 1;
  }
  return { currentRows, appended, allocatedIds };
}

export function validateDreamContract({
  dreamText,
  lessonsText,
  passDate,
  beforeDreamText,
  dreamSnapshot,
  beforeLessonsText,
  lessonSnapshot,
} = {}) {
  const failures = [];
  let priorDream = dreamSnapshot;
  if (beforeDreamText !== undefined) {
    priorDream = captureNightlyContractSnapshot({ dreamText: beforeDreamText }).dream;
  }
  if (!priorDream || priorDream.missing || !Number.isInteger(priorDream.byte_length)
      || typeof priorDream.prefix_hash !== 'string') {
    failures.push('DREAM trusted pre-pass snapshot missing');
  } else {
    const currentBuffer = Buffer.from(String(dreamText), 'utf8');
    const priorBytes = currentBuffer.subarray(0, priorDream.byte_length).toString('utf8');
    if (currentBuffer.length < priorDream.byte_length
        || sha256(priorBytes) !== priorDream.prefix_hash) {
      failures.push('DREAM pre-pass prefix changed; nightly synthesis must append only');
    }
  }
  const newest = newestDatedHeader(dreamText, 'dream').newest;
  if (newest !== passDate) failures.push(`newest DREAM header ${newest || 'none'} != ${passDate}`);

  let snapshot = lessonSnapshot;
  if (beforeLessonsText !== undefined) {
    snapshot = snapshotJsonl(beforeLessonsText, 'LESSONS', 'lesson_id');
  }
  const suffix = validateJsonlSuffix({
    currentText: lessonsText,
    snapshot,
    label: 'LESSONS',
    idField: 'lesson_id',
    prefix: 'l',
    failures,
  });
  const added = suffix.appended;
  for (const [index, row] of added.entries()) {
    if (!row || typeof row.lesson !== 'string' || !row.lesson.trim()) {
      failures.push(`new lesson ${index + 1} missing text`);
    }
    if (!LESSON_TYPES.has(row.type)) failures.push(`new lesson ${index + 1} invalid type`);
    if (typeof row.confidence !== 'number' || row.confidence < 0 || row.confidence > 1) {
      failures.push(`new lesson ${index + 1} invalid confidence`);
    }
    if (row.created_at !== passDate) failures.push(`new lesson ${index + 1} created_at != ${passDate}`);
    if (!validateAdmission(row)) failures.push(`new lesson ${index + 1} admission predicate failed`);
    if (row.admission?.kind === 'mechanical-red-green' && row.confidence > 0.85) {
      failures.push(`new lesson ${index + 1} mechanical confidence exceeds 0.85`);
    }
  }

  const block = maskMarkdownFences(datedBlock(dreamText, passDate));
  const sections = dreamSectionBodies(block);
  for (const label of DREAM_SECTIONS) {
    if (!sections.has(label)) failures.push(`Dream section missing: ${label}`);
    else if (!sections.get(label)) failures.push(`Dream section empty: ${label}`);
  }
  const candidates = [
    ...block.matchAll(
      /^###[ \t]+(ni-\d{8}-\d+)\b([\s\S]*?)(?=^###|^##|(?![\s\S]))/gm,
    ),
  ];
  const candidateIds = new Set();
  for (const candidate of candidates) {
    const status = candidate[2]
      .match(/^-[ \t]+\*\*status:\*\*[ \t]*(\S+)/mi)?.[1] || null;
    if (status !== 'proposed') {
      failures.push(`new Dream candidate ${candidate[1]} status=${status || 'missing'}`);
    }
    if (!candidate[1].startsWith(`ni-${String(passDate).replace(/-/g, '')}-`)) {
      failures.push(`new Dream candidate ${candidate[1]} date does not match ${passDate}`);
    }
    if (candidateIds.has(candidate[1])) {
      failures.push(`new Dream candidate id collides: ${candidate[1]}`);
    }
    candidateIds.add(candidate[1]);
    for (const field of [
      'evidence',
      'failure class',
      'proposed_change',
      'mutation proof',
      'operator gate',
    ]) {
      const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const value = candidate[2].match(
        new RegExp(`^-[ \\t]+\\*\\*${escaped}:\\*\\*[ \\t]*(.+)$`, 'mi'),
      )?.[1]?.trim();
      if (!value) failures.push(`new Dream candidate ${candidate[1]} missing ${field}`);
    }
  }

  const lessonSummary = sections.get('Lessons extracted') || '';
  if (added.length === 0 && !/(?:no lessons extracted this pass|\bnone\b)/i.test(lessonSummary)) {
    failures.push('zero-lesson Dream entry does not say no lessons extracted this pass');
  }
  if (added.length > 0 && /(?:no lessons extracted this pass|^\s*none\b)/i.test(lessonSummary)) {
    failures.push('Dream lesson summary says none despite appended lessons');
  }
  const candidateSummary = sections.get('Improvement candidates proposed') || '';
  if (candidates.length === 0 && !/\bnone\b/i.test(candidateSummary)) {
    failures.push('zero-candidate Dream entry does not say none');
  }
  if (candidates.length > 0 && /^\s*none\b/i.test(candidateSummary)) {
    failures.push('Dream candidate summary says none despite candidates');
  }
  return {
    ok: failures.length === 0,
    failures,
    newest,
    lessonsAdded: added.length,
    candidates: candidates.length,
    output: `DREAM_CONTRACT ${failures.length ? 'FAIL' : 'PASS'} date=${passDate}`
      + ` lessons_added=${added.length} candidates=${candidates.length}`
      + ` failures=${failures.length ? failures.join('|') : 'none'}`,
  };
}

export function validateCognitiveContract({
  goalsText,
  beliefsText,
  selfModelText,
  proceduresText,
  beforeBeliefsText,
  beforeProceduresText,
  beforeSelfModelText,
  cognitiveSnapshot,
  newBeliefIds,
  newProcedureIds,
  selfAliasAdditions,
} = {}) {
  const failures = [];
  try {
    JSON.parse(goalsText);
  } catch (error) {
    failures.push(`GOAL_STACK invalid JSON: ${error?.message || error}`);
  }
  let selfModel = {};
  try {
    selfModel = JSON.parse(selfModelText);
  } catch (error) {
    failures.push(`SELF_MODEL invalid JSON: ${error?.message || error}`);
  }
  let snapshot = cognitiveSnapshot;
  if (beforeBeliefsText !== undefined
      || beforeProceduresText !== undefined
      || beforeSelfModelText !== undefined) {
    snapshot = captureNightlyContractSnapshot({
      lessonsText: '',
      beliefsText: beforeBeliefsText,
      proceduresText: beforeProceduresText,
      selfModelText: beforeSelfModelText,
    });
  }
  const beliefResult = validateJsonlSuffix({
    currentText: beliefsText,
    snapshot: snapshot?.beliefs,
    label: 'BELIEF_STATE',
    idField: 'belief_id',
    prefix: 'b',
    allowRevision: true,
    failures,
  });
  const procedureResult = validateJsonlSuffix({
    currentText: proceduresText,
    snapshot: snapshot?.procedures,
    label: 'PROCEDURES',
    idField: 'proc_id',
    prefix: 'p',
    failures,
  });
  for (const [index, row] of beliefResult.appended.entries()) {
    if (typeof row.belief !== 'string' || !row.belief.trim()) {
      failures.push(`new belief ${index + 1} missing belief text`);
    }
    if (typeof row.confidence !== 'number' || row.confidence < 0 || row.confidence > 1) {
      failures.push(`new belief ${index + 1} invalid confidence`);
    }
    if (typeof row.source !== 'string' || !row.source.trim()) {
      failures.push(`new belief ${index + 1} missing source`);
    }
    if (typeof row.status !== 'string' || !row.status.trim()) {
      failures.push(`new belief ${index + 1} missing status`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.last_checked || ''))) {
      failures.push(`new belief ${index + 1} invalid last_checked`);
    }
  }
  for (const [index, row] of procedureResult.appended.entries()) {
    for (const field of ['name', 'procedure', 'applicable_when', 'source']) {
      if (typeof row[field] !== 'string' || !row[field].trim()) {
        failures.push(`new procedure ${index + 1} missing ${field}`);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.created_at || ''))) {
      failures.push(`new procedure ${index + 1} invalid created_at`);
    }
  }
  if (newBeliefIds !== undefined && !sameStringSet(newBeliefIds, beliefResult.allocatedIds)) {
    failures.push(
      `declared new belief ids omit or add rows:`
      + ` declared=${exactStringSet(newBeliefIds).join(',') || 'none'}`
      + ` actual=${beliefResult.allocatedIds.join(',') || 'none'}`,
    );
  }
  if (newProcedureIds !== undefined
      && !sameStringSet(newProcedureIds, procedureResult.allocatedIds)) {
    failures.push(
      `declared new procedure ids omit or add rows:`
      + ` declared=${exactStringSet(newProcedureIds).join(',') || 'none'}`
      + ` actual=${procedureResult.allocatedIds.join(',') || 'none'}`,
    );
  }

  const beforeSelf = snapshot?.self_model?.value;
  const aliasAdditions = [];
  let aliasChanges = 0;
  if (!beforeSelf || snapshot?.self_model?.missing) {
    failures.push('SELF_MODEL trusted pre-pass snapshot missing');
  } else {
    for (const [left, right] of [
      ['capabilities', 'known_capabilities'],
      ['limitations', 'known_limitations'],
    ]) {
      if (!Array.isArray(beforeSelf[left]) || !Array.isArray(beforeSelf[right])
          || !Array.isArray(selfModel[left]) || !Array.isArray(selfModel[right])) {
        failures.push(`SELF_MODEL alias arrays missing: ${left}/${right}`);
        continue;
      }
      const leftAdded = setDifference(selfModel[left], beforeSelf[left]);
      const rightAdded = setDifference(selfModel[right], beforeSelf[right]);
      const leftRemoved = setDifference(beforeSelf[left], selfModel[left]);
      const rightRemoved = setDifference(beforeSelf[right], selfModel[right]);
      if (!sameStringSet(leftAdded, rightAdded) || !sameStringSet(leftRemoved, rightRemoved)) {
        failures.push(`SELF_MODEL alias mismatch: ${left}/${right}`);
      }
      aliasAdditions.push(...leftAdded);
      aliasChanges += leftAdded.length + leftRemoved.length;
    }
  }
  if (selfAliasAdditions !== undefined
      && !sameStringSet(selfAliasAdditions, aliasAdditions)) {
    failures.push(
      `declared SELF_MODEL alias additions omit or add values:`
      + ` declared=${exactStringSet(selfAliasAdditions).join(',') || 'none'}`
      + ` actual=${exactStringSet(aliasAdditions).join(',') || 'none'}`,
    );
  }
  return {
    ok: failures.length === 0,
    failures,
    output: `COGNITIVE_CONTRACT ${failures.length ? 'FAIL' : 'PASS'}`
      + ` new_beliefs=${beliefResult.allocatedIds.length}`
      + ` new_procedures=${procedureResult.allocatedIds.length}`
      + ` alias_changes=${aliasChanges}`
      + ` failures=${failures.length ? failures.join('|') : 'none'}`,
  };
}

export function validateMetaGate({ dreamText, candidateId } = {}) {
  const escaped = String(candidateId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const searchable = maskMarkdownFences(String(dreamText));
  const match = searchable.match(
    new RegExp(`^###\\s+${escaped}\\b([\\s\\S]*?)(?=^###|^##|(?![\\s\\S]))`, 'm'),
  );
  const failures = [];
  if (!String(candidateId || '').trim()) failures.push('candidate id missing');
  if (!match) failures.push(`candidate not found: ${candidateId}`);
  const block = match?.[1] || '';
  const status = block.match(
    /^-[ \t]+\*\*status:\*\*[ \t]*(\S+)/mi,
  )?.[1] || null;
  const operatorEvidence = block.match(
    /^-[ \t]+\*\*operator evidence:\*\*[ \t]*(.+)$/mi,
  )?.[1]?.trim() || null;
  const operatorEvidenceValid = Boolean(operatorEvidence)
    && operatorEvidence.length >= 8
    && !/^(?:none|pending|n\/a|todo|approve(?:d)?|yes|approve\s*\/\s*reject\s*\/\s*revise)$/i
      .test(operatorEvidence)
    && /(?:operator|human|user|turn|message|transcript|conversation|source|#[a-z0-9_-]+)/i
      .test(operatorEvidence);
  if (status !== 'approved') failures.push(`candidate status ${status || 'missing'} is not approved`);
  if (!operatorEvidenceValid) failures.push('operator approval evidence missing');
  return {
    ok: failures.length === 0,
    failures,
    candidateId,
    operatorEvidence,
    output: `META_GATE ${failures.length ? 'FAIL' : 'PASS'}`
      + ` candidate=${candidateId || 'none'}`
      + ` status=${status || 'missing'}`
      + ` operator_evidence=${operatorEvidenceValid ? 'valid' : 'invalid'}`
      + ` failures=${failures.length ? failures.join('|') : 'none'}`,
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const next = argv[index + 1];
    const hasValue = next !== undefined && !next.startsWith('--');
    out[token.slice(2)] = hasValue ? next : true;
    if (hasValue) index += 1;
  }
  return out;
}

const direct = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (direct) {
  try {
    const cli = parseArgs(process.argv.slice(2));
    const action = cli._[0];
    const root = path.resolve(String(cli.root || defaultNightlyRoot()));
    const paths = resolveNightlyPaths(root);
    const memoryFile = (relative) => resolveMemoryRelative(paths, relative);
    let result;
    if (action === 'snapshot') {
      if (!cli.out) throw new Error('snapshot requires --out PATH');
      const output = path.resolve(String(cli.out));
      const snapshot = captureNightlyContractSnapshot({
        dreamText: readFileSync(memoryFile('DREAM_LOG.md'), 'utf8'),
        lessonsText: readFileSync(memoryFile('runtime/LESSONS.jsonl'), 'utf8'),
        beliefsText: readFileSync(memoryFile('runtime/BELIEF_STATE.jsonl'), 'utf8'),
        proceduresText: readFileSync(memoryFile('runtime/PROCEDURES.jsonl'), 'utf8'),
        selfModelText: readFileSync(memoryFile('runtime/SELF_MODEL.json'), 'utf8'),
      });
      mkdirSync(path.dirname(output), { recursive: true });
      const temp = `${output}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(temp, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
      renameSync(temp, output);
      result = {
        ok: true,
        output: `NIGHTLY_CONTRACT_SNAPSHOT PASS out=${output.replace(/\\/g, '/')}`
          + ` lessons=${snapshot.lessons.line_count}`
          + ` beliefs=${snapshot.beliefs.line_count}`
          + ` procedures=${snapshot.procedures.line_count}`,
      };
    } else if (action === 'dream') {
      const snapshotFile = cli.snapshot
        ? path.resolve(root, String(cli.snapshot))
        : memoryFile('runtime/NIGHTLY_PASS_STATE.json');
      const snapshotDocument = JSON.parse(readFileSync(snapshotFile, 'utf8'));
      result = validateDreamContract({
        dreamText: readFileSync(memoryFile('DREAM_LOG.md'), 'utf8'),
        lessonsText: readFileSync(memoryFile('runtime/LESSONS.jsonl'), 'utf8'),
        passDate: String(cli.date || ''),
        dreamSnapshot: (snapshotDocument.contract_snapshot || snapshotDocument).dream,
        lessonSnapshot: (snapshotDocument.contract_snapshot || snapshotDocument).lessons,
      });
    } else if (action === 'cognitive') {
      const snapshotFile = cli.snapshot
        ? path.resolve(root, String(cli.snapshot))
        : memoryFile('runtime/NIGHTLY_PASS_STATE.json');
      const snapshotDocument = JSON.parse(readFileSync(snapshotFile, 'utf8'));
      result = validateCognitiveContract({
        goalsText: readFileSync(memoryFile('runtime/GOAL_STACK.json'), 'utf8'),
        beliefsText: readFileSync(memoryFile('runtime/BELIEF_STATE.jsonl'), 'utf8'),
        selfModelText: readFileSync(memoryFile('runtime/SELF_MODEL.json'), 'utf8'),
        proceduresText: readFileSync(memoryFile('runtime/PROCEDURES.jsonl'), 'utf8'),
        cognitiveSnapshot: snapshotDocument.contract_snapshot || snapshotDocument,
        newBeliefIds: cli['new-belief-ids'] === undefined
          ? undefined
          : String(cli['new-belief-ids']).split(',').filter(Boolean),
        newProcedureIds: cli['new-procedure-ids'] === undefined
          ? undefined
          : String(cli['new-procedure-ids']).split(',').filter(Boolean),
        selfAliasAdditions: cli['self-alias-additions'] === undefined
          ? undefined
          : String(cli['self-alias-additions']).split(',').filter(Boolean),
      });
    } else if (action === 'meta') {
      result = validateMetaGate({
        dreamText: readFileSync(memoryFile('DREAM_LOG.md'), 'utf8'),
        candidateId: String(cli.candidate || ''),
      });
    } else {
      throw new Error(
        'usage: nightly-contracts.mjs snapshot|dream|cognitive|meta --root PATH [options]',
      );
    }
    process.stdout.write(result.output + '\n');
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(
      `NIGHTLY_CONTRACT ERROR ${String(error?.message || error).replace(/[\r\n]+/g, ' ')}\n`,
    );
    process.exit(2);
  }
}
