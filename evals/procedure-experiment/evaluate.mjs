// A finite declarative grammar, not a natural-language compliance evaluator.
export const selectedStep = '2. collect scope=selected resolve=writer match=op,kind,target where=*';
export const allStep = '2. collect scope=local resolve=writer match=op,kind,target where=*';

export function parseStep(step) {
  const match = /^2\. collect scope=(selected|local|all) resolve=(writer|any|none) match=([a-z,]+) where=(.+)$/.exec(step);
  if (!match) throw new Error('UNKNOWN: unparseable procedure');
  const [, scope, resolution, names, where] = match;
  const fields = names.split(',');
  if (new Set(fields).size !== fields.length || fields.some((f) => !['op', 'kind', 'target'].includes(f))) {
    throw new Error('UNKNOWN: invalid match fields');
  }
  let op = null;
  if (where !== '*') {
    try { op = JSON.parse(where); } catch { throw new Error('UNKNOWN: invalid operation filter'); }
    if (typeof op !== 'string') throw new Error('UNKNOWN: invalid operation filter');
  }
  return { scope, resolution, fields, op };
}

export function executeProcedure(procedure, input, baseline) {
  const steps = procedure.split(/\r?\n/).filter((line) => /^\d\. /.test(line));
  if (steps.length !== 4 || procedure.replace(steps[1], () => selectedStep) !== baseline) {
    throw new Error('UNKNOWN: unparseable procedure');
  }
  const rule = parseStep(steps[1]);
  if (!Array.isArray(input.artifacts) || !input.artifacts.some((a) => a.id === input.selected)) {
    throw new Error('UNKNOWN: missing selected artifact');
  }
  const local = input.artifacts.filter((a) => a.scope === input.scope);
  const source = rule.scope === 'all' ? input.artifacts
    : rule.scope === 'selected' ? local.filter((a) => a.id === input.selected) : local;
  const identity = (row) => JSON.stringify(rule.fields.map((field) =>
    field === 'kind' ? row[field]?.replace(/^sidechain:/, '') : row[field]));
  const retired = new Set(local.filter((a) => rule.resolution === 'any'
    || (rule.resolution === 'writer' && a.writer === true)).flatMap((a) => a.rows)
    .filter((r) => ['confirmed', 'failed'].includes(r.outcome)).map(identity));
  return [...new Set(source.flatMap((a) => a.rows)
    .filter((r) => ['requested', 'unknown'].includes(r.outcome) && !retired.has(identity(r)))
    .filter((r) => rule.op === null || r.op === rule.op).map((r) => r.op))].sort();
}
