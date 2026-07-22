// capsule-verb.mjs — capsule content validation shared by writers and tests.
// The former trusted-writer orchestration (evidence collection, digest/pointer
// stamping, the refresh-cycle record) has been retired along with the tower that
// drove it — the operator-facing capsule procedure writes, confirms, and stops
// directly. This module's remaining job is validateCapsuleText(): the one place
// required-field presence and the content gate agree about the same bytes.

import { contentProblems } from './capsule-content-gate.mjs';

const REQUIRED_CAPSULE_FIELDS = Object.freeze([
  'id', 'objective', 'waiting_on', 'next_valid_action',
]);

function frontmatterOf(text) {
  return String(text).match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1] ?? null;
}

function frontmatterScalar(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!match) return null;
  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  } else {
    value = value.replace(/\s+#.*$/, '').trim();
  }
  return value;
}

function hasUnsupportedInlineComment(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!match) return false;
  const raw = match[1];
  let quote = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote === '"') {
      if (char === '\\') index += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'" && raw[index + 1] === "'") index += 1;
      else if (char === "'") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && index > 0 && /\s/.test(raw[index - 1])) return true;
  }
  return false;
}

function isUnquotedYamlNull(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!match) return false;
  let raw = match[1].trim();
  if (raw.startsWith('"') || raw.startsWith("'")) return false;
  raw = raw.replace(/\s+#.*$/, '').trim();
  return /^(?:null|~)$/i.test(raw);
}

export function validateCapsuleText(text) {
  const frontmatter = frontmatterOf(text);
  if (frontmatter === null) {
    return { fields: {}, problems: ['capsule must begin with a closed YAML frontmatter block'] };
  }

  const fields = {};
  const problems = [];
  for (const field of REQUIRED_CAPSULE_FIELDS) {
    fields[field] = frontmatterScalar(frontmatter, field);
    if (typeof fields[field] !== 'string' || fields[field].length === 0) {
      problems.push(`capsule frontmatter ${field} must be non-empty`);
    }
    if (hasUnsupportedInlineComment(frontmatter, field)) {
      problems.push(`capsule frontmatter ${field} must not use an inline YAML comment`);
    }
  }
  // YAML null is not a non-empty waiting_on value, even though older capsules
  // used it as a shorthand. A quoted "null" remains an intentional string.
  if (isUnquotedYamlNull(frontmatter, 'waiting_on')) {
    problems.push('capsule frontmatter waiting_on must be non-empty (unquoted YAML null is empty)');
  }
  // non-null ≠ resumable: field MEANING gate. A capsule whose objective is
  // harness-injection echo or whose next_valid_action opens with resume ceremony
  // passed every non-empty check above yet strands a fresh session. Vocabulary
  // lives in capsule-content-gate.mjs, shared with the stop-writer.
  problems.push(...contentProblems(fields));
  return { fields, problems };
}
