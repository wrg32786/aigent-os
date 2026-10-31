// Bounded interpreter for the four-step fixture. No model, shell or evidence execution.
export const selectedStep = '2. Collect unresolved operations from the selected artifact.';
export const allStep = '2. Collect unresolved operations from all artifacts in the same scope.';
export const overfitStep = '2. Collect only unresolved operation pending from all artifacts in the same scope.';

export function executeProcedure(procedure, input, baseline) {
  const steps = procedure.split(/\r?\n/).filter((line) => /^\d\. /.test(line));
  if (steps.length !== 4 || ![selectedStep, allStep, overfitStep].includes(steps[1])
      || steps[0] !== '1. Select the newest valid artifact for the objective.'
      || steps[2] !== '3. Retire an operation only on a writer-owned confirmed or failed row in the same scope.'
      || steps[3] !== '4. Report unresolved operation ids in sorted order; never retry an operation here.'
      || procedure.replace(steps[1], selectedStep) !== baseline) {
    throw new Error('UNKNOWN: unsupported procedure');
  }
  if (!Array.isArray(input.artifacts) || !input.artifacts.some((a) => a.id === input.selected)) {
    throw new Error('UNKNOWN: missing selected artifact');
  }
  const local = input.artifacts.filter((a) => a.scope === input.scope);
  const source = steps[1] === selectedStep ? local.filter((a) => a.id === input.selected) : local;
  const retired = new Set(local.filter((a) => a.writer === true).flatMap((a) => a.rows)
    .filter((r) => ['confirmed', 'failed'].includes(r.outcome)).map((r) => r.op));
  return [...new Set(source.flatMap((a) => a.rows)
    .filter((r) => ['requested', 'unknown'].includes(r.outcome) && !retired.has(r.op))
    .filter((r) => steps[1] !== overfitStep || r.op === 'pending').map((r) => r.op))].sort();
}
