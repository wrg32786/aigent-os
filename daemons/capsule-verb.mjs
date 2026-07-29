// capsule-verb.mjs — capsule content validation shared by writers and tests.
// The former trusted-writer orchestration (evidence collection, digest/pointer
// stamping, the refresh-cycle record) has been retired along with the tower that
// drove it — the operator-facing capsule procedure writes, confirms, and stops
// directly. This module's remaining job is validateCapsuleText(): the one place
// required-field presence and the content gate agree about the same bytes.

import { contentProblems } from './capsule-content-gate.mjs';
import {
  hasFrontmatter,
  scalar,
  scalarHasUnsupportedInlineComment,
  scalarIsUnquotedYamlNull,
} from './lifecycle-common.mjs';

const REQUIRED_CAPSULE_FIELDS = Object.freeze([
  'id', 'objective', 'waiting_on', 'next_valid_action',
]);

export function validateCapsuleText(text) {
  if (!hasFrontmatter(text)) {
    return { fields: {}, problems: ['capsule must begin with a closed YAML frontmatter block'] };
  }

  const fields = {};
  const problems = [];
  for (const field of REQUIRED_CAPSULE_FIELDS) {
    fields[field] = scalar(text, field);
    if (typeof fields[field] !== 'string' || fields[field].trim().length === 0) {
      problems.push(`capsule frontmatter ${field} must be non-empty`);
    }
    if (scalarHasUnsupportedInlineComment(text, field)) {
      problems.push(`capsule frontmatter ${field} must not use an inline YAML comment`);
    }
  }
  // YAML null is not a non-empty waiting_on value, even though older capsules
  // used it as a shorthand. A quoted "null" remains an intentional string.
  if (scalarIsUnquotedYamlNull(text, 'waiting_on')) {
    problems.push('capsule frontmatter waiting_on must be non-empty (unquoted YAML null is empty)');
  }
  // non-null ≠ resumable: field MEANING gate. A capsule whose objective is
  // harness-injection echo or whose next_valid_action opens with resume ceremony
  // passed every non-empty check above yet strands a fresh session. Vocabulary
  // lives in capsule-content-gate.mjs, shared with the stop-writer.
  problems.push(...contentProblems(fields));
  return { fields, problems };
}
