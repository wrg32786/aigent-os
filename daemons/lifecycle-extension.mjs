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

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inert } from './lifecycle-common.mjs';

export const LIFECYCLE_EXTENSION_REL = path.join('.aigent', 'lifecycle-extension.json');
const SCHEMA = 'LifecycleExtension/v1';
const FIELDS = Object.freeze(['resume_ack', 'capsule_ack']);
const ALLOWED_KEYS = new Set(['schema', ...FIELDS]);
const CLI_FLAGS = new Set(['--root', '--capsule-id']);
export const CAPSULE_ID_SLOT = '{capsule_id}';
// ONE bound, used by the validator and by the renderer, so the two can never
// disagree about what "too long" means. They used to be separate literals: the
// validator measured the TEMPLATE and the renderer measured the SUBSTITUTED
// string, so a template sitting exactly on the cap passed validation and then
// rendered with the capsule id cut in half.
// Measured at adoption: core's longest authored procedure line is 372 chars and
// the real handshake text this must carry is 322, so 500 clears both.
export const FIELD_MAX_CHARS = 500;
// The budget a {capsule_id} slot is charged at validation time. A declaration is
// accepted only if it still fits with an id this long substituted, so an
// accepted declaration can never render truncated. Real ids measure in the 20s
// to 60s of characters; 128 is deliberate headroom.
export const CAPSULE_ID_MAX_CHARS = 128;
// The declared text is a PROTOCOL BODY: the seat is told to send it verbatim,
// so the render must not quote or escape it the way inert() does for diagnostic
// values. A quote or a backslash in the body reached the seat escaped and the
// supervisor never matched it. What the render still guarantees is the property
// that matters for safety, which is that the value can never own a line of its
// own inside the injected procedure: every line-breaking and control character
// is folded to a space. The validator already refuses such a field outright;
// this is the second, independent guard. On an ACCEPTED body the fold is the
// identity: it touches only characters the validator refuses, so the data a
// supervisor asserts on, the resume step and the capsule stdout are one string.
// Runs of ordinary spaces are the operator's bytes and are left alone.
export function foldDeclaredLine(value) {
  return String(value ?? '')
    .replace(/[\r\n\u2028\u2029\u0085]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, ' ')
    .trim();
}

// ONE greppable token on every diagnostic this seam emits. An operator chasing
// a supervisor hold-timeout greps it and finds the cause, whichever path held
// the handshake: a refused declaration, or an accepted field that could not be
// rendered truthfully.
export const WARNING_TOKEN = 'LIFECYCLE-EXTENSION:';
export const WARNING_PREFIX = `${WARNING_TOKEN} declaration ignored:`;

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

function fieldProblem(rawValue) {
  if (typeof rawValue !== 'string') return 'must be a string';
  // Trim BEFORE measuring anything below. The loader stores `raw[field].trim()`
  // (see the FIELDS loop), so validating the untrimmed string checked a
  // different string than the one that gets accepted and sent: a field padded
  // with whitespace could sit over the cap, or carry a trailing newline, and be
  // refused for a property its trimmed form never had.
  const value = rawValue.trim();
  if (value.length === 0) return 'must not be empty';
  // One line, always. A multi-line instruction could open a line of its own
  // inside the injected procedure and impersonate a core step or a fence.
  // inert() folds line breaks at render time too; this is the second,
  // independent guard, refusing the file rather than silently reshaping it.
  if (/[\r\n\u2028\u2029\u0085]/.test(value)) return 'must be a single line';
  // Bidi and format controls join C0/DEL: a declaration is one VISIBLE line the
  // seat sends verbatim, and an override can reverse or hide the text the
  // operator read back, so what was approved and what is sent stop matching.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(value)) return 'must not contain control or bidi characters';
  // Reasons are spelled without the slot literal: they land in the injected
  // procedure, and an unsubstituted slot must never appear there.
  if (value.split(CAPSULE_ID_SLOT).length > 2) return 'must carry the capsule id slot at most once';
  // Measure what will actually be SENT, charging the slot its full id budget.
  // Measuring the template instead is what let an accepted declaration render
  // truncated.
  const resolvedMax = value.includes(CAPSULE_ID_SLOT)
    ? value.length - CAPSULE_ID_SLOT.length + CAPSULE_ID_MAX_CHARS
    : value.length;
  if (resolvedMax > FIELD_MAX_CHARS) {
    return value.includes(CAPSULE_ID_SLOT)
      ? `must be at most ${FIELD_MAX_CHARS} characters once the capsule id slot is filled `
        + `(worst case ${resolvedMax}, allowing ${CAPSULE_ID_MAX_CHARS} for the id)`
      : `must be at most ${FIELD_MAX_CHARS} characters`;
  }
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
    // Windows editors write a BOM by default; refusing one turns an ordinary
    // edit into a silently unarmed handshake.
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
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
 * Always returns {line, warning}. line is null when there is nothing to run: no
 * declaration, or a template that needs an id when no capsule was loaded. That
 * second case is the fail-safe the degraded resume path depends on -- with no
 * capsule there is nothing truthful to announce, so the step must not render at
 * all rather than invite a fabricated id.
 *
 * A HELD field is never silent. When a declaration exists and its field does
 * not render, warning names the field and the reason, under the same greppable
 * token as a refusal. Silence on either surface reads as "nothing declared",
 * which is exactly the half-armed handshake this seam exists to prevent. The
 * warning never echoes the declared text: the reason the step is held is that
 * there is nothing truthful to send.
 */
export function resolveLifecycleAck(template, capsuleId, field = 'field') {
  if (typeof template !== 'string' || template.length === 0) return { line: null, warning: null };
  if (!template.includes(CAPSULE_ID_SLOT)) return { line: foldDeclaredLine(template), warning: null };
  if (typeof capsuleId !== 'string' || capsuleId.trim().length === 0) {
    return {
      line: null,
      // Spelled without the slot literal: an unsubstituted slot must never
      // appear anywhere in the injected procedure, warnings included.
      warning: `${WARNING_TOKEN} ${field} not rendered: it carries a capsule id slot and no capsule was loaded to fill it`,
    };
  }
  const resolved = template.split(CAPSULE_ID_SLOT).join(capsuleId.trim());
  // The validator charged the slot CAPSULE_ID_MAX_CHARS, so this is unreachable
  // for any id inside that budget. It is here because the alternative to
  // holding the step is handing the seat a truncated body it was told to send
  // verbatim, and a silently wrong handshake is worse than an absent one.
  if (resolved.length > FIELD_MAX_CHARS) {
    return {
      line: null,
      warning: `${WARNING_TOKEN} ${field} not rendered: with this capsule id substituted it is ${resolved.length} characters, over the ${FIELD_MAX_CHARS} cap`,
    };
  }
  return { line: foldDeclaredLine(resolved), warning: null };
}

// ── The capsule surface's entry point ────────────────────────────────────────
//
// The resume surface reaches this module through resume-verb.mjs. The capsule
// surface is a SKILL, so without an entry point of its own the only way for it
// to honor a declaration was to instruct the model to read the JSON itself.
// That is how one file came to be REFUSED on resume and HONORED on capsule:
// two readers, one of which was a paragraph of English with no validator behind
// it. This CLI gives both surfaces the same loader, the same validator and the
// same renderer.
//
// Contract: print the resolved line on stdout, or print nothing and put one
// greppable warning on stderr. ALWAYS exit 0 -- this runs inside the capsule
// verb, and a non-zero exit there would turn a bad declaration into a failed
// capsule, which is the fail-closed behavior this seam exists to avoid.
export function renderCli(argv, out = process.stdout, err = process.stderr) {
  try {
    if (argv[0] !== 'render') {
      err.write(`${WARNING_PREFIX} unknown command: ${inert(argv[0] ?? '')}\n`);
      return 0;
    }
    const field = argv[1];
    if (!FIELDS.includes(field)) {
      err.write(`${WARNING_PREFIX} unknown field: ${inert(field ?? '')}\n`);
      return 0;
    }
    // The arguments are a reader too, and they validate like the file does.
    // A blind pair scan took a flag name as a value and substituted it into
    // the body the seat sends byte for byte, and a misspelled or valueless
    // --root fell through to ENOENT and printed nothing on either stream,
    // which the capsule skill reads as "no declaration". Every malformed
    // invocation refuses under the same token, and refuses whole.
    const opts = new Map();
    for (let i = 2; i < argv.length; i += 2) {
      const flag = argv[i];
      const value = argv[i + 1];
      if (!CLI_FLAGS.has(flag)) {
        err.write(`${WARNING_PREFIX} unknown argument: ${inert(flag)}\n`);
        return 0;
      }
      if (typeof value !== 'string' || value.startsWith('--')) {
        err.write(`${WARNING_PREFIX} ${flag} needs a value\n`);
        return 0;
      }
      if (opts.has(flag)) {
        err.write(`${WARNING_PREFIX} ${flag} given twice\n`);
        return 0;
      }
      opts.set(flag, value);
    }
    const root = opts.get('--root') || process.cwd();
    let isDirectory = false;
    try { isDirectory = statSync(root).isDirectory(); } catch { isDirectory = false; }
    if (!isDirectory) {
      err.write(`${WARNING_PREFIX} --root is not a directory: ${inert(root)}\n`);
      return 0;
    }
    const capsuleId = opts.get('--capsule-id') || '';

    const extension = loadLifecycleExtension(root);
    if (extension.warning) {
      err.write(`${extension.warning}\n`);
      return 0;
    }
    const { line, warning } = resolveLifecycleAck(extension[field], capsuleId, field);
    if (warning) err.write(`${warning}\n`);
    if (line) out.write(`${line}\n`);
    return 0;
  } catch (error) {
    // Even an unexpected throw degrades to "no extension", loudly.
    err.write(`${WARNING_PREFIX} renderer failed: ${inert(error?.message || String(error))}\n`);
    return 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = renderCli(process.argv.slice(2));
}
