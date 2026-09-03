// lifecycle-extension.mjs — the one optional seam a governed install uses to
// attach its own lifecycle handshake to the CORE verbs.
//
// The problem this closes: an install supervised by an outside process needs
// the resume and capsule verbs to announce completion in that process's own
// protocol. Without a seam the only way to carry it is a forked copy of the
// core lifecycle skill, which the installer then treats as drift and
// quarantines, so the next clear never announces and the supervisor holds the
// seat forever. The seam makes that handshake a DECLARED extension instead.
//
// The declaration is DATA, never code: <target>/.aigent/lifecycle-extension.json
// holds at most two single-line instruction strings. Nothing here loads a
// module, spawns a process, or learns any particular supervisor's vocabulary --
// core stays ignorant of the protocol it is carrying, which is the whole point.
// .aigent/ is outside every installer-managed tree (install.sh MANAGED_PREFIXES
// / MANAGED_EXACT), so the declaration survives an install and an update with
// no preservation entry of its own.
//
// FAIL-OPEN, on purpose, and the opposite of namespace-registry.mjs's
// fail-closed process.exit(1). That registry gates indexing, where refusing to
// run is the safe direction. This gates SESSION START, where refusing to run
// wedges every clear on the seat, and resume-verb.mjs's standing invariant is
// that nothing may break session start. So an unusable declaration degrades to
// exactly the stock behavior plus ONE greppable warning, and the caller keeps
// going. Fail-open is not fail-silent: the warning exists so an operator
// chasing a supervisor hold-timeout can grep one token and find the cause.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inert } from './lifecycle-common.mjs';

export const LIFECYCLE_EXTENSION_REL = path.join('.aigent', 'lifecycle-extension.json');
const SCHEMA = 'LifecycleExtension/v1';
const FIELDS = Object.freeze(['resume_ack', 'capsule_ack']);
const ALLOWED_KEYS = new Set(['schema', ...FIELDS]);
export const CAPSULE_ID_SLOT = '{capsule_id}';
// Bound reused from inert()'s own default rather than invented here, so the
// render and the validation can never disagree about what "too long" means.
// Measured at adoption: core's longest authored procedure line is 372 chars and
// the real handshake text this must carry is 322, so 500 clears both.
export const FIELD_MAX_CHARS = 500;
export const WARNING_PREFIX = 'LIFECYCLE-EXTENSION: declaration ignored:';

// A rejected declaration is rejected WHOLE. Accepting the readable half of a
// malformed file is how an operator ends up believing a handshake is armed
// when only part of it is -- the same reasoning namespace-registry.mjs states
// as "no caller is allowed to recover a partial population from malformed
// input".
function refuse(declarationPath, reason) {
  // Neither half after the fixed prefix is authored text. The path comes from
  // the filesystem, and two of the reasons embed the runtime error, whose V8
  // JSON form QUOTES the first bytes of the offending file. Measured, node v24:
  // JSON.parse over a file whose first bytes are two newlines returns a message
  // carrying a literal line break, so an unscrubbed reason turns the
  // one-warning contract into one warning plus a line the declaration author
  // chose, landing inside the injected procedure. inert() is the repo's single
  // render chokepoint for persisted text (issue #43): folded to one line,
  // quoted, bounded. The prefix stays outside it so the greppable token
  // survives.
  return {
    resume_ack: null,
    capsule_ack: null,
    warning: `${WARNING_PREFIX} ${inert(declarationPath)}: ${inert(reason)}`,
  };
}

function fieldProblem(value) {
  if (typeof value !== 'string') return 'must be a string';
  if (value.trim().length === 0) return 'must not be empty';
  // One line, always. A multi-line instruction could open a line of its own
  // inside the injected procedure and impersonate a core step or a fence.
  // inert() folds line breaks at render time too; this is the second,
  // independent guard, refusing the file rather than silently reshaping it.
  if (/[\r\n]/.test(value)) return 'must be a single line';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'must not contain control characters';
  if (value.length > FIELD_MAX_CHARS) return `must be at most ${FIELD_MAX_CHARS} characters`;
  if (value.split(CAPSULE_ID_SLOT).length > 2) return `must use ${CAPSULE_ID_SLOT} at most once`;
  return null;
}

/**
 * Read and validate <projectRoot>/.aigent/lifecycle-extension.json.
 *
 * Always returns {resume_ack, capsule_ack, warning}. Absent file is the stock
 * install: all three null, no warning, nothing to report. Present but unusable:
 * both fields null and one warning line. Never throws.
 */
export function loadLifecycleExtension(projectRoot) {
  const declarationPath = path.join(projectRoot, LIFECYCLE_EXTENSION_REL);
  const none = { resume_ack: null, capsule_ack: null, warning: null };

  let text;
  try {
    text = readFileSync(declarationPath, 'utf8');
  } catch (error) {
    // ENOENT is the fresh-install state and says nothing. Any OTHER read error
    // means a declaration is probably there and is NOT being honored, which the
    // operator has to hear about.
    if (error && error.code === 'ENOENT') return none;
    return refuse(declarationPath, `cannot be read (${error?.code || error?.message || error})`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return refuse(declarationPath, `is not valid JSON (${error.message})`);
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return refuse(declarationPath, 'root must be an object');
  }
  if (raw.schema !== SCHEMA) {
    return refuse(declarationPath, `schema must equal exactly ${SCHEMA}`);
  }
  // An unknown key is refused rather than ignored: the likely cause is a
  // misspelled field name, and silently ignoring it arms nothing while looking
  // exactly like a working declaration.
  const unknown = Object.keys(raw).filter((key) => !ALLOWED_KEYS.has(key)).sort();
  if (unknown.length > 0) {
    return refuse(declarationPath, `has unsupported key(s): ${unknown.join(', ')}`);
  }

  const accepted = { resume_ack: null, capsule_ack: null, warning: null };
  for (const field of FIELDS) {
    if (!(field in raw)) continue;
    const problem = fieldProblem(raw[field]);
    if (problem) return refuse(declarationPath, `${field} ${problem}`);
    accepted[field] = raw[field].trim();
  }
  return accepted;
}

/**
 * Resolve one declared field against the loaded capsule id.
 *
 * Returns null when there is nothing to run: no declaration, or a template that
 * needs an id when no capsule was loaded. That second case is the fail-safe the
 * degraded resume path depends on -- with no capsule there is nothing truthful
 * to announce, so the step must not render at all rather than invite a
 * fabricated id.
 */
export function resolveLifecycleAck(template, capsuleId) {
  if (typeof template !== 'string' || template.length === 0) return null;
  if (!template.includes(CAPSULE_ID_SLOT)) return template;
  if (typeof capsuleId !== 'string' || capsuleId.trim().length === 0) return null;
  return template.split(CAPSULE_ID_SLOT).join(capsuleId.trim());
}
