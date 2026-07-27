// budget.mjs -- hard size budgets for the memory surfaces that are injected
// into every session.
//
// THE FAILURE THIS EXISTS FOR: the always-injected files grow one honest line at
// a time. Every single addition is defensible. Nobody ever decides to make the
// priorities file 29,000 characters long; it simply arrives there, and by then
// the cost is paid on every turn of every session forever, invisibly, because a
// large file reads exactly like a small one.
//
// The pre-existing guard for this is a nightly report and a manual trim step in
// the close checklist. Both are post-hoc: they observe the bloat after it is
// already being injected, and both depend on somebody acting on the finding.
// This module is the write-time half. A write that would push a hot surface past
// its budget is refused at the moment it is attempted, with the consolidation
// instruction attached, so the trim happens while the author is still holding
// the context that would let them do it well.
//
// The budget is deliberately generous. This is not a style rule about concise
// writing; it is a ceiling that only a file nobody has pruned in months can hit.

// Budgets are keyed by basename, because the same surface lives at different
// absolute paths in a vault, in a test fixture, and in a fresh install.
export const SURFACE_BUDGETS = Object.freeze({
  'ACTIVE_PRIORITIES.md': Object.freeze({
    maxChars: 12000,
    maxLines: 150,
    why: 'read on every session open and re-read after every compaction',
    consolidate: 'Move completed and superseded fronts into '
      + 'ACTIVE_PRIORITIES_ARCHIVE_<date>.md and link it, keeping only the live '
      + 'fronts and their current next actions here.',
  }),
  'SESSION_LOG.md': Object.freeze({
    maxChars: 24000,
    maxLines: 300,
    why: 'the session-continuity surface, re-read on open and on resume',
    consolidate: 'Move the oldest entries into SESSION_LOG_ARCHIVE_<date>.md, '
      + 'keeping the newest few sessions here in full detail.',
  }),
  'MEMORY_CANDIDATES.md': Object.freeze({
    maxChars: 20000,
    maxLines: 250,
    why: 'a staging queue, not a store: unbounded growth here means digest is not running',
    consolidate: 'Run the digest verb: promote what earned a place, mark the '
      + 'rest skipped, and drop rows that were resolved elsewhere.',
  }),
});

export function budgetFor(filePath, budgets = SURFACE_BUDGETS) {
  const name = String(filePath || '').replace(/\\/g, '/').split('/').pop() || '';
  return budgets[name] ? { name, ...budgets[name] } : null;
}

// A surface is over budget when EITHER dimension is exceeded. Characters catch
// long prose; lines catch a list that grew a thousand short entries. Either one
// alone can be gamed by the other shape.
export function measure(text) {
  const source = String(text ?? '');
  return {
    chars: source.length,
    lines: source.length === 0 ? 0 : source.split(/\r?\n/).length,
  };
}

export function checkBudget(filePath, text, budgets = SURFACE_BUDGETS) {
  const budget = budgetFor(filePath, budgets);
  if (!budget) {
    return {
      governed: false, ok: true, over: [], budget: null, ...measure(text),
    };
  }
  const size = measure(text);
  const over = [];
  if (size.chars > budget.maxChars) over.push('chars');
  if (size.lines > budget.maxLines) over.push('lines');
  return {
    governed: true,
    ok: over.length === 0,
    over,
    budget,
    name: budget.name,
    ...size,
  };
}

// The refusal text is the whole point of the mechanism. A bare "too big" leaves
// the author guessing at both the target and the method, and the usual reaction
// to a guessed target is to shave a few lines and retry until it passes, which
// is how a budget turns into a nuisance instead of a prune.
export function consolidationPrompt(verdict) {
  if (!verdict || verdict.ok) return '';
  const { budget } = verdict;
  const dimensions = verdict.over
    .map((dimension) => (dimension === 'chars'
      ? `${verdict.chars} characters (budget ${budget.maxChars})`
      : `${verdict.lines} lines (budget ${budget.maxLines})`))
    .join(' and ');
  return `[memory-budget] REFUSED: this write puts ${verdict.name} at ${dimensions}.

${verdict.name} is ${budget.why}, so every character here is paid on every turn of every session.

Consolidate first, then write:
  ${budget.consolidate}

Consolidating means moving content out, not compressing it in place. Nothing needs to be deleted; it needs to stop being injected.

(To disable this gate: set AIGENT_MEMORY_BUDGET=off)`;
}
