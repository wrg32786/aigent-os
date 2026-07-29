'use strict';

// One parser owns the boundary between frontmatter/body bytes and values used
// by production code. Safe readers collapse every character that can terminate
// or control a rendered line. Raw readers exist only for transformations that
// genuinely need multiline source and refuse calls without a written reason.

const LINE_BREAKING = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function escaped(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requireReason(reason, accessor) {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new TypeError(`${accessor} requires a non-empty reason string`);
  }
}

function collapseLineBreaking(value) {
  if (value === null || value === undefined) return value;
  return String(value).replace(LINE_BREAKING, ' ');
}

function rawFrontmatter(doc) {
  return String(doc ?? '').match(FRONTMATTER)?.[1] ?? null;
}

function rawScalarToken(doc, key) {
  const frontmatter = rawFrontmatter(doc);
  if (frontmatter === null) return null;
  // Only CR/LF delimit YAML physical lines. Multiline regex anchors also treat
  // U+2028/U+2029 as line starts, which would let a hidden field appear after a
  // Unicode separator before the reader had a chance to collapse it.
  const expression = new RegExp(`^${escaped(key)}:[ \\t]*([^\\r\\n]*)$`);
  for (const line of frontmatter.split(/\r\n|\n|\r/)) {
    const match = line.match(expression);
    if (match) return match[1].trim();
  }
  return null;
}

function inlineCommentIndex(raw) {
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
    if (char === '#' && (index === 0 || /\s/.test(raw[index - 1]))) return index;
  }
  return -1;
}

function decodeScalar(raw) {
  let value = String(raw).trim();
  const comment = inlineCommentIndex(value);
  if (comment >= 0) value = value.slice(0, comment).trimEnd();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Valid YAML double-quoted strings are not necessarily valid JSON.
    }
    return value.slice(1, -1);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function hasFrontmatter(doc) {
  return rawFrontmatter(doc) !== null;
}

function unsafeRawScalar(doc, key, reason) {
  requireReason(reason, 'unsafeRawScalar');
  const raw = rawScalarToken(doc, key);
  return raw === null ? null : decodeScalar(raw);
}

function scalar(doc, key) {
  const value = unsafeRawScalar(
    doc,
    key,
    'the safe scalar reader collapses line-breaking characters before returning',
  );
  return collapseLineBreaking(value);
}

function headingPattern(key) {
  return escaped(key).replace(/_/g, '[ _]');
}

function unsafeRawBodySection(doc, key, reason) {
  requireReason(reason, 'unsafeRawBodySection');
  const source = String(doc ?? '');
  const frontmatter = source.match(FRONTMATTER);
  const body = frontmatter ? source.slice(frontmatter[0].length) : source;
  const match = body.match(
    new RegExp(
      `(?:^|\\r?\\n)#{1,6}[ \\t]+${headingPattern(key)}[ \\t]*\\r?\\n`
        + `([\\s\\S]*?)(?=\\r?\\n#{1,6}[ \\t]|$)`,
      'i',
    ),
  );
  const value = match?.[1]?.trim();
  return value || null;
}

function bodySection(doc, key) {
  const value = unsafeRawBodySection(
    doc,
    key,
    'the safe body reader collapses multiline body content before returning',
  );
  return collapseLineBreaking(value);
}

function unsafeRawCapsuleValue(doc, key, reason) {
  requireReason(reason, 'unsafeRawCapsuleValue');
  return unsafeRawScalar(doc, key, reason) || unsafeRawBodySection(doc, key, reason);
}

function unsafeRawDocumentBody(doc, reason) {
  requireReason(reason, 'unsafeRawDocumentBody');
  const source = String(doc ?? '');
  const match = source.match(FRONTMATTER);
  return (match ? source.slice(match[0].length) : source).trim();
}

function unsafeRawRewriteScalar(doc, key, expected, replacement, reason) {
  requireReason(reason, 'unsafeRawRewriteScalar');
  const source = String(doc ?? '');
  const frontmatter = source.match(FRONTMATTER);
  if (!frontmatter) return source;
  const marked = frontmatter[0].replace(
    new RegExp(
      `(^|\\n)(${escaped(key)}:[ \\t]*)(['"]?)${escaped(expected)}\\3[ \\t]*(?=\\r?(?:\\n|$))`,
    ),
    (_match, boundary, prefix) => `${boundary}${prefix}${replacement}`,
  );
  return marked === frontmatter[0]
    ? source
    : marked + source.slice(frontmatter[0].length);
}

function capsuleValue(doc, key) {
  return scalar(doc, key) || bodySection(doc, key);
}

function frontmatterList(doc, key) {
  const frontmatter = rawFrontmatter(doc);
  if (frontmatter === null) return [];
  const lines = frontmatter.split(/\r?\n/);
  const keyLine = new RegExp(`^${escaped(key)}:[ \\t]*([^\\r\\n]*)$`, 'i');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(keyLine);
    if (!match) continue;
    let inline = match[1].trim();
    const comment = inlineCommentIndex(inline);
    if (comment >= 0) inline = inline.slice(0, comment).trimEnd();
    if (inline) {
      const contents = inline.startsWith('[') && inline.endsWith(']')
        ? inline.slice(1, -1).split(',')
        : [inline];
      return contents
        .map((item) => collapseLineBreaking(decodeScalar(item)).trim())
        .filter(Boolean);
    }
    const values = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const item = lines[cursor].match(/^[ \t]+-[ \t]+([^\r\n]+?)[ \t]*$/);
      if (item) {
        values.push(collapseLineBreaking(decodeScalar(item[1])).trim());
        continue;
      }
      if (/^\S/.test(lines[cursor])) break;
    }
    return values.filter(Boolean);
  }
  return [];
}

function scalarHasUnsupportedInlineComment(doc, key) {
  const raw = rawScalarToken(doc, key);
  return raw !== null && inlineCommentIndex(raw) >= 0;
}

function scalarIsUnquotedYamlNull(doc, key) {
  const raw = rawScalarToken(doc, key);
  if (raw === null || raw.startsWith('"') || raw.startsWith("'")) return false;
  const comment = inlineCommentIndex(raw);
  const value = (comment >= 0 ? raw.slice(0, comment) : raw).trim();
  return /^(?:null|~)$/i.test(value);
}

module.exports = {
  bodySection,
  capsuleValue,
  collapseLineBreaking,
  frontmatterList,
  hasFrontmatter,
  scalar,
  scalarHasUnsupportedInlineComment,
  scalarIsUnquotedYamlNull,
  unsafeRawBodySection,
  unsafeRawCapsuleValue,
  unsafeRawDocumentBody,
  unsafeRawRewriteScalar,
  unsafeRawScalar,
};
