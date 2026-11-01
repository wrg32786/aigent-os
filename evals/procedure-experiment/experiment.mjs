// Local, sequential fixture adapter for the existing Finding -> Dream -> eval path.
// Only a newly allocated temporary fixture can be mutated. No live-target option.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveCorpus } from './corpus.mjs';
import { observeLedgerFinding } from '../../daemons/nightly-ledger-stage.mjs';
import { validateMetaGate } from '../../daemons/nightly-contracts.mjs';
import { executeProcedure, selectedStep, allStep } from './evaluate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const stamp = () => new Date().toISOString();
const copy = (value) => JSON.parse(JSON.stringify(value));
const ledger = 'vault/memory/runtime/NIGHTLY_CAPTURE_CANDIDATES.jsonl';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createExperiment({ replacement = allStep, author = 'procedure-author', budgets = {}, sourceRefs } = {}) {
  if (typeof author !== 'string' || !/^[a-zA-Z0-9:._-]+$/.test(author)) throw new Error('author identity required');
  const ceilings = { growth_bytes: 128, max_cases: 32, procedure_bytes: 2048, corpus_bytes: 65536 };
  for (const [key, value] of Object.entries(budgets)) {
    if (!Object.hasOwn(ceilings, key) || !Number.isFinite(value) || value < 0 || value > ceilings[key]) {
      throw new Error('invalid fixture budget');
    }
  }
  const manifest = JSON.parse(readFileSync(path.join(HERE, 'cases.json')));
  const corpus = deriveCorpus(manifest);
  const root = mkdtempSync(path.join(os.tmpdir(), 'procedure-experiment-'));
  const pins = new Map();
  let frozen = false;
  let candidate;
  let plan;
  let measurement;
  let verdict;
  let adopted = false;
  const file = (name) => path.join(root, name);
  const read = (name) => {
    const target = file(name);
    const st = lstatSync(target);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1
        || !realpathSync(target).startsWith(realpathSync(root) + path.sep)) throw new Error('unsafe fixture path');
    return readFileSync(target);
  };
  const write = (name, bytes, exclusive = true) => {
    mkdirSync(path.dirname(file(name)), { recursive: true });
    if (existsSync(file(name))) read(name);
    writeFileSync(file(name), bytes, { flag: exclusive ? 'wx' : 'w' });
  };
  const record = (name, value) => {
    write(name, json(value));
    pins.set(name, sha(read(name)));
    return copy(value);
  };
  const intact = () => {
    for (const [name, digest] of pins) {
      try { if (sha(read(name)) !== digest) throw new Error(); }
      catch { throw new Error(`HOLD: frozen or evidence record changed: ${name}`); }
    }
  };
  const base = readFileSync(path.join(HERE, 'procedure.md'));
  const incident = JSON.parse(readFileSync(path.join(HERE, 'incident.json')));
  const cases = [incident.origin, ...corpus.cases];
  const evidence = sourceRefs === undefined ? incident.source_refs : copy(sourceRefs);
  const evidenceValid = same(evidence, incident.source_refs);
  write('procedure.md', base);
  write('baseline.md', base);
  write('incident.json', json(incident));
  write('cases.json', json(cases));
  write('corpus-source.mjs', corpus.source);
  write('corpus-provenance.json', json(corpus.provenance));
  write('observed.json', json(incident.observed));
  mkdirSync(file('vault/memory/runtime'), { recursive: true });

  // Existing producer selects its state root from the environment. Keep that
  // override scoped to this synchronous call; never inherit a live state home.
  const observe = () => {
    const previous = process.env.AIGENT_STATE_HOME_DIR;
    process.env.AIGENT_STATE_HOME_DIR = root;
    try { return observeLedgerFinding({ root, target: 'observed.json', expected: sha(json(incident.expected)) }); }
    finally {
      if (previous === undefined) delete process.env.AIGENT_STATE_HOME_DIR;
      else process.env.AIGENT_STATE_HOME_DIR = previous;
    }
  };
  const dreamBlock = (status, evidence) => `### ${candidate.proposal_id} - Preserve unresolved state\n`
    + `- **status:** ${status}\n- **evidence:** ${candidate.created_from.join('; ')}\n`
    + '- **failure class:** selected-artifact state loss\n'
    + `- **proposed_change:** ${replacement}\n`
    + '- **mutation proof:** selected-only -> origin red; all-in-scope -> origin green\n'
    + '- **operator gate:** approve / reject / revise\n'
    + `- **operator evidence:** ${evidence}\n`;

  function propose() {
    if (candidate) { intact(); return copy(candidate); }
    const finding = observe();
    if (finding.finding?.finding.state !== 'FAIL') throw new Error('UNKNOWN/HOLD: no observed failure');
    // A Finding proves only a hash mismatch. Pin this adapter's one admitted
    // incident separately; arbitrary mismatches must never become its evidence.
    if (sha(read('observed.json')) !== sha(json(incident.observed))
        || sha(read('incident.json')) !== sha(json(incident))
        || sha(read('cases.json')) !== sha(json(cases))
        || sha(read('baseline.md')) !== sha(base) || sha(read('procedure.md')) !== sha(base)) {
      throw new Error('UNKNOWN/HOLD: missing or ambiguous incident evidence');
    }
    const before = base.toString('utf8');
    if (before.split(selectedStep).length !== 2) throw new Error('ambiguous delta');
    const after = before.replace(selectedStep, () => replacement);
    const identity = sha(json({ base: sha(base), replacement, evidence }));
    // Record the tested proposal identity and delta. Dream remains proposed throughout.
    candidate = {
      proposal_id: `ni-20261031-${identity.slice(0, 12)}`, author, status: 'proposed',
      created_from: [`finding:${finding.finding.candidate_id}`, ...finding.finding.source_refs, ...evidence],
      procedure: { sha256: sha(base) },
      candidate_sha256: sha(after), delta: { before: selectedStep, after: replacement },
      lineage: { parent_sha256: sha(base) },
    };
    record('candidate.json', candidate);
    write('candidate.md', after);
    write('vault/memory/DREAM_LOG.md', dreamBlock('proposed', 'pending'));
    for (const name of ['baseline.md', 'candidate.md', 'incident.json', 'cases.json', 'observed.json', ledger,
      'vault/memory/DREAM_LOG.md', 'corpus-source.mjs', 'corpus-provenance.json']) pins.set(name, sha(read(name)));
    return copy(candidate);
  }

  function freeze() {
    if (!candidate) throw new Error('propose before freeze');
    intact();
    if (frozen) throw new Error('freeze already recorded');
    plan = {
      provenance: corpus.provenance,
      budgets: { ...ceilings, ...budgets },
      candidate_sha256: candidate.candidate_sha256,
      instrument_sha256: sha(readFileSync(path.join(HERE, 'evaluate.mjs'))),
      adapter_sha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    };
    record('preregistration.json', plan);
    // Rollback exists before any verdict or adoption, with exact original bytes.
    record('rollback.json', { recorded_at: stamp() });
    frozen = true;
    return copy(plan);
  }

  function evaluate() {
    if (!frozen) throw new Error('freeze required before evaluation');
    intact();
    if (measurement) throw new Error('stopping rule: already evaluated');
    if (sha(readFileSync(path.join(HERE, 'evaluate.mjs'))) !== plan.instrument_sha256
        || sha(readFileSync(fileURLToPath(import.meta.url))) !== plan.adapter_sha256) throw new Error('HOLD: instrument changed');
    const results = [];
    for (const scenario of ['BASELINE', 'CANDIDATE']) {
      const procedure = read(scenario === 'BASELINE' ? 'baseline.md' : 'candidate.md').toString('utf8');
      for (const c of cases) {
        try {
          const actual = executeProcedure(procedure, c, base.toString('utf8'));
          results.push({ scenario, id: c.id, status: same(actual, c.expected) ? 'pass' : 'fail',
            actual, expected: c.expected });
        } catch {
          results.push({ scenario, id: c.id, status: 'unknown' });
        }
      }
    }
    const costs = { growth_bytes: Math.max(0, read('candidate.md').length - base.length),
      max_cases: cases.length, procedure_bytes: read('candidate.md').length, corpus_bytes: read('cases.json').length };
    const failures = results.filter((r) => r.scenario === 'CANDIDATE' && r.status !== 'pass').map((r) => r.id);
    if (!evidenceValid) failures.push('evidence:untrusted-source-refs');
    for (const key of Object.keys(costs)) if (costs[key] > plan.budgets[key]) failures.push(`budget:${key}`);
    const originRed = results.some((r) => r.scenario === 'BASELINE' && r.id === 'origin' && r.status === 'fail');
    measurement = {
      terminal: results.some((r) => r.scenario === 'CANDIDATE' && r.status === 'unknown')
        ? 'UNKNOWN' : failures.length ? 'REJECT' : originRed ? 'PASS' : 'NO_IMPROVEMENT',
      costs, failures, results,
    };
    return record('evaluation.json', measurement);
  }

  function judge({ evaluator = `deterministic:${plan?.instrument_sha256}`, note, votes } = {}) {
    if (!measurement) throw new Error('evaluation required');
    intact();
    if (evaluator === author) throw new Error('author-equals-evaluator refuses');
    if (evaluator !== `deterministic:${plan.instrument_sha256}`) throw new Error('unrecognized evaluator');
    if (note !== undefined || votes !== undefined) throw new Error('model notes and votes cannot produce a verdict');
    verdict = { evaluator,
      measurement_sha256: pins.get('evaluation.json'), verdict: measurement.terminal === 'PASS' ? 'ADOPT' : measurement.terminal,
      evaluated_at: stamp() };
    return record('VERDICT.json', verdict);
  }

  function promote(approval) {
    intact();
    if (!verdict || verdict.verdict !== 'ADOPT') throw new Error('passing independent verdict required');
    if (sha(read('procedure.md')) !== candidate.procedure.sha256) throw new Error('stale base refuses');
    if (approval?.actor === author) throw new Error('author-equals-approver refuses');
    if (!approval || approval.decision !== 'approve-fixture'
        || typeof approval.actor !== 'string' || !/^[a-zA-Z0-9:._-]+$/.test(approval.actor)
        || approval.candidate_sha256 !== candidate.candidate_sha256 || approval.candidate_id !== candidate.proposal_id
        || approval.base_sha256 !== candidate.procedure.sha256
        || typeof approval.evidence !== 'string' || /[\r\n]/.test(approval.evidence)) {
      throw new Error('absent approval or wrong candidate/base/evidence refuses');
    }
    const gate = validateMetaGate({ dreamText: dreamBlock('approved', approval.evidence), candidateId: candidate.proposal_id });
    if (!gate.ok) throw new Error(gate.output);
    const current = read('procedure.md').toString('utf8');
    const priorRegions = current.split(candidate.delta.before);
    if (priorRegions.length !== 2) throw new Error('ambiguous delta');
    const updated = current.replace(candidate.delta.before, () => candidate.delta.after);
    if (sha(updated) !== plan.candidate_sha256) throw new Error('wrong tested candidate refuses');
    record('approval.json', approval);
    write('procedure.md', updated, false);
    adopted = true;
    const persisted = read('procedure.md').toString('utf8');
    const afterRegions = persisted.split(candidate.delta.after);
    if (sha(persisted) !== plan.candidate_sha256 || afterRegions.length !== 2) throw new Error('application verification failed');
    record('application.json', { after: sha(persisted),
      unrelated_before: priorRegions.map(sha), unrelated_after: afterRegions.map(sha) });
    return JSON.parse(read('application.json'));
  }

  function rollback() {
    intact();
    if (!adopted || sha(read('procedure.md')) !== plan.candidate_sha256) throw new Error('rollback current hash refuses');
    const prior = read('baseline.md');
    if (sha(prior) !== candidate.procedure.sha256) throw new Error('rollback prior hash refuses');
    write('procedure.md', prior, false);
    adopted = false;
    return record('rollback-result.json', { restored_sha256: sha(read('procedure.md')) });
  }

  return { root, propose, freeze, evaluate, judge, promote, rollback, observe,
    read: (name) => read(name),
    cleanup: () => {
      const resolved = path.resolve(root);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('procedure-experiment-')) {
        throw new Error('cleanup outside fixture');
      }
      rmSync(resolved, { recursive: true, force: true });
    } };
}
