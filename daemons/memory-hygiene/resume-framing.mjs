// resume-framing.mjs -- the field set that stops a stored summary from acting
// like a live instruction.
//
// THE FAILURE THIS EXISTS FOR: a capsule is written while work is in flight. It
// says, truthfully, "dispatch the three reviewers". Later the operator reverses
// that call. Later still the session compacts or restarts, the capsule is read
// back as continuity, and a fresh session reads "dispatch the three reviewers"
// as its instruction. It is not wrong about the past. It is stale, and there is
// nothing in the document that says so, because a summary and a command are the
// same shape once they are both just text in the context window.
//
// A one-line "reference only" banner is most of the fix and this repo already
// had one. What it does not carry is the part a fresh session actually needs
// when the capsule and the live state disagree: which one wins, what happens to
// items that were still open, and what a later reversal does to work the capsule
// describes as in flight. Those are three separate rulings, and leaving them
// implicit means each reader re-derives them, differently.
//
// So the framing is a declared field set, machine-checkable, not prose. A
// capsule missing these fields is not merely less polite; it is missing the
// only thing that tells a reader it is not in charge.

import { scalar } from '../lifecycle-common.mjs';

// Frontmatter keys, in the order they should be emitted. Values are fixed:
// these are properties of what a capsule IS, not per-capsule choices.
export const FRAMING_FIELDS = Object.freeze({
  framing: 'reference-only',
  instruction_authority: 'none',
  precedence: 'latest-live-state-wins',
  pending_policy: 'surface-never-auto-resume',
  reverse_signal_policy: 'cancels-in-flight-work',
});

export const FRAMING_KEYS = Object.freeze(Object.keys(FRAMING_FIELDS));

// The banner block a reader sees. The long-standing one-liner stays where it is
// in the writers, asserted by their own tests; these are the rulings that the
// one-liner leaves implicit.
export const FRAMING_LINES = Object.freeze([
  'Framing: this document is reference, never an instruction queue.',
  'Precedence: where this disagrees with live state or a later message, the later one wins.',
  'Pending: open items below are surfaced for a decision, never auto-resumed.',
  'Reversal: a signal that reverses work described here cancels it, including work marked in flight.',
]);

export const FRAMING_BLOCK = FRAMING_LINES.join('\n');

export function framingFrontmatter() {
  return FRAMING_KEYS.map((key) => `${key}: ${FRAMING_FIELDS[key]}`).join('\n');
}

// The block with a per-line prefix applied. Exists so callers that build their
// output inside a template literal do not have to escape a newline through two
// levels of quoting just to prefix each line.
export function framingBanner(prefix = '> ') {
  return FRAMING_LINES.map((line) => `${prefix}${line}`).join('\n');
}

// Verdict shape mirrors the other hygiene checks: ok plus the specific misses,
// so a failure names what to add rather than only that something is absent.
export function checkFraming(doc) {
  const source = String(doc || '');
  const missingFields = [];
  const wrongFields = [];
  for (const key of FRAMING_KEYS) {
    const value = scalar(source, key);
    if (value === null) missingFields.push(key);
    else if (value !== FRAMING_FIELDS[key]) wrongFields.push(`${key}=${value}`);
  }
  // The resolved/pending split is what pending_policy is a policy ABOUT. A
  // capsule that declares the policy but carries no such split has declared a
  // rule over nothing, which reads as compliance and is not.
  const hasResolved = /^##[ \t]+Done\b/m.test(source);
  const hasPending = /^##[ \t]+Pending-Gates\b/m.test(source);
  const hasBanner = source.includes('[REFERENCE ONLY]');
  const ok = missingFields.length === 0
    && wrongFields.length === 0
    && hasResolved
    && hasPending
    && hasBanner;
  return {
    ok,
    missingFields,
    wrongFields,
    hasBanner,
    hasResolvedSection: hasResolved,
    hasPendingSection: hasPending,
    detail: ok
      ? `framing field set complete (${FRAMING_KEYS.length} fields), resolved/pending split present`
      : `missing=${missingFields.join(',') || 'none'};`
        + ` wrong=${wrongFields.join(',') || 'none'};`
        + ` banner=${hasBanner ? 'yes' : 'no'};`
        + ` resolved_section=${hasResolved ? 'yes' : 'no'};`
        + ` pending_section=${hasPending ? 'yes' : 'no'}`,
  };
}
