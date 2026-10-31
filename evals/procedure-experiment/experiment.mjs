// Local, sequential fixture adapter for the existing Finding -> Dream -> eval path.
// Only a newly allocated temporary fixture can be mutated. No live-target option.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
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

export function createExperiment({ replacement = allStep, author = 'procedure-author', budgets = {} } = {}) {
  if (typeof author !== 'string' || !/^[a-zA-Z0-9:._-]+$/.test(author)) throw new Error('author identity required');
  const ceilings = { tokens: 0, latency_ms: 1000, growth_bytes: 128, max_cases: 7 };
  for (const [key, value] of Object.entries(budgets)) {
    if (!Object.hasOwn(ceilings, key) || !Number.isFinite(value) || value < 0 || value > ceilings[key]) {
      throw new Error('invalid fixture budget');
    }
  }
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
  const cases = [incident.origin, ...JSON.parse(readFileSync(path.join(HERE, 'cases.json')))];
  write('procedure.md', base);
  write('baseline.md', base);
  write('incident.json', json(incident));
  write('cases.json', json(cases));
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
    const after = before.replace(selectedStep, replacement);
    const identity = sha(json({ base: sha(base), replacement, evidence: incident.source_refs }));
    // Reuse the documented proposal object, with exact procedure identity and
    // delta as additional evidence fields. Dream remains proposed throughout.
    candidate = {
      proposal_id: `ni-20261031-${identity.slice(0, 12)}`, author, status: 'proposed',
      created_from: [`finding:${finding.finding.candidate_id}`, ...finding.finding.source_refs, ...incident.source_refs],
      observation: incident.observation, hypothesis: incident.proposed_explanation,
      expected_change: replacement, success_predicate: 'origin fixed; held-out and healthy all pass; within budgets',
      falsifying_result: 'any candidate failure, regression, unknown, or budget overrun',
      evaluation: null, result: null, promoted_to: null, rejected_reason: null,
      procedure: { path: 'procedure.md', sha256: sha(base) },
      candidate_sha256: sha(after), delta: { before: selectedStep, after: replacement },
      lineage: { parent_sha256: sha(base), supersedes: null, finding_id: finding.finding.candidate_id },
    };
    record('candidate.json', candidate);
    write('candidate.md', after);
    write('vault/memory/DREAM_LOG.md', dreamBlock('proposed', 'pending'));
    for (const name of ['baseline.md', 'candidate.md', 'incident.json', 'cases.json', 'observed.json', ledger,
      'vault/memory/DREAM_LOG.md']) pins.set(name, sha(read(name)));
    return copy(candidate);
  }

  function freeze() {
    if (!candidate) throw new Error('propose before freeze');
    intact();
    if (frozen) throw new Error('freeze already recorded');
    plan = {
      hypothesis: candidate.hypothesis,
      population: cases.map((c) => ({ id: c.id, class: c.class })),
      held_out: cases.filter((c) => c.class === 'held-out').map((c) => c.id),
      metric: 'exact sorted unresolved operation ids; zero candidate errors and regressions',
      budgets: { ...ceilings, ...budgets },
      stopping_rule: 'one sequential pass of both versions over every case; no retries or tuning',
      baseline_sha256: sha(base), candidate_sha256: candidate.candidate_sha256,
      candidate_record_sha256: pins.get('candidate.json'), corpus_sha256: pins.get('cases.json'),
      instrument_sha256: sha(readFileSync(path.join(HERE, 'evaluate.mjs'))),
      adapter_sha256: sha(readFileSync(fileURLToPath(import.meta.url))),
      frozen_at: stamp(),
    };
    record('preregistration.json', plan);
    // Rollback exists before any verdict or adoption, with exact original bytes.
    record('rollback.json', { target: 'procedure.md', prior_sha256: sha(base), artifact: 'baseline.md',
      reason: 'bounded fixture experiment; restore after application proof', recorded_at: stamp() });
    frozen = true;
    return copy(plan);
  }

  function evaluate() {
    if (!frozen) throw new Error('freeze required before evaluation');
    intact();
    if (measurement) throw new Error('stopping rule: already evaluated');
    if (sha(readFileSync(path.join(HERE, 'evaluate.mjs'))) !== plan.instrument_sha256
        || sha(readFileSync(fileURLToPath(import.meta.url))) !== plan.adapter_sha256) throw new Error('HOLD: instrument changed');
    const start = performance.now();
    const results = [];
    for (const scenario of ['BASELINE', 'CANDIDATE']) {
      const procedure = read(scenario === 'BASELINE' ? 'baseline.md' : 'candidate.md').toString('utf8');
      for (const c of cases) {
        try {
          const actual = executeProcedure(procedure, c, base.toString('utf8'));
          results.push({ scenario, id: c.id, class: c.class, status: same(actual, c.expected) ? 'pass' : 'fail',
            detail: same(actual, c.expected) ? 'exact match' : 'unresolved-state mismatch', actual, expected: c.expected });
        } catch {
          results.push({ scenario, id: c.id, class: c.class, status: 'unrunnable', detail: 'UNKNOWN: unsupported procedure or evidence' });
        }
      }
    }
    const costs = { tokens: 0, latency_ms: performance.now() - start,
      growth_bytes: read('candidate.md').length - base.length, max_cases: cases.length };
    const failures = results.filter((r) => r.scenario === 'CANDIDATE' && r.status !== 'pass').map((r) => r.id);
    for (const key of Object.keys(costs)) if (costs[key] > plan.budgets[key]) failures.push(`budget:${key}`);
    const originRed = results.some((r) => r.scenario === 'BASELINE' && r.id === 'origin' && r.status === 'fail');
    measurement = {
      preregistration: 'preregistration.json', packet_sha256: pins.get('preregistration.json'),
      scenario: 'BASELINE/CANDIDATE', instrument_sha256: plan.instrument_sha256,
      terminal: failures.length ? 'REJECT' : originRed ? 'PASS' : 'NO_IMPROVEMENT',
      ran_at: stamp(), wall_ms: costs.latency_ms, hashes: { baseline: plan.baseline_sha256, candidate: plan.candidate_sha256 },
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
    verdict = { evaluator, author, candidate_sha256: candidate.candidate_sha256,
      measurement_sha256: pins.get('evaluation.json'), verdict: measurement.terminal === 'PASS' ? 'ADOPT' : measurement.terminal,
      reason: measurement.failures.length ? measurement.failures.join(', ') : measurement.terminal,
      rollback: 'rollback.json', evaluated_at: stamp(), scope: 'fixture only; no independent human review claimed' };
    return record('VERDICT.json', verdict);
  }

  function promote(approval) {
    intact();
    if (!verdict || verdict.verdict !== 'ADOPT') throw new Error('passing independent verdict required');
    if (sha(read('procedure.md')) !== candidate.procedure.sha256) throw new Error('stale base refuses');
    if (!approval || approval.decision !== 'approve-fixture' || approval.actor !== 'fixture-operator'
        || approval.candidate_sha256 !== candidate.candidate_sha256 || approval.candidate_id !== candidate.proposal_id
        || approval.base_sha256 !== candidate.procedure.sha256 || approval.evidence !== 'human:test-fixture-explicit-approval') {
      throw new Error('absent approval or wrong candidate/base/evidence refuses');
    }
    const gate = validateMetaGate({ dreamText: dreamBlock('approved', approval.evidence), candidateId: candidate.proposal_id });
    if (!gate.ok) throw new Error(gate.output);
    const current = read('procedure.md').toString('utf8');
    const [prefix, suffix] = current.split(candidate.delta.before);
    const updated = prefix + candidate.delta.after + suffix;
    if (sha(updated) !== plan.candidate_sha256) throw new Error('wrong tested candidate refuses');
    record('approval.json', { ...approval, approved_at: stamp() });
    record('application.json', { before: sha(current), after: sha(updated),
      unrelated_before: [sha(prefix), sha(suffix)], unrelated_after: [sha(prefix), sha(suffix)], applied_at: stamp() });
    write('procedure.md', updated, false);
    adopted = true;
    return JSON.parse(read('application.json'));
  }

  function rollback() {
    intact();
    if (!adopted || sha(read('procedure.md')) !== plan.candidate_sha256) throw new Error('rollback current hash refuses');
    const prior = read('baseline.md');
    if (sha(prior) !== candidate.procedure.sha256) throw new Error('rollback prior hash refuses');
    write('procedure.md', prior, false);
    adopted = false;
    return record('rollback-result.json', { restored_sha256: sha(read('procedure.md')), reason: 'fixture completed', rolled_back_at: stamp() });
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
