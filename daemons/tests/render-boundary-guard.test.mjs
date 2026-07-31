// RENDER_BOUNDARY_STRUCTURAL_GUARD_V1
//
// This is a source-structure gate, not a behavior-only test. A new production
// parser or raw reader must be centralized or declared here with one exact use
// and a written reason; otherwise the file and line are named in the failure.

import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const PROBE_DIR = path.join(TEST_DIR, 'fixtures', 'render-boundary-guard');
const JS_ROOTS = ['daemons', 'hooks', 'launcher', 'scripts', 'tools'];
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', 'test', 'tests']);
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const CANONICAL_JS_READER = 'daemons/frontmatter-reader.cjs';
const CANONICAL_PYTHON_READER = 'daemons/render_boundary.py';
const PYTHON_PUBLIC_READERS = new Set([
  'body_section',
  'capsule_value',
  'collapse_data',
  'collapse_line_breaking',
  'inert',
  'scalar',
  'unsafeRawBodySection',
  'unsafeRawCapsuleParts',
  'unsafeRawCapsuleValue',
  'unsafeRawScalar',
]);
const MINIMUM_COUNTS = Object.freeze({ javascript: 42, shell: 28, python: 6 });

function relative(file) {
  return path.relative(REPO_ROOT, file).replace(/\\/g, '/');
}

function probeSource(name) {
  return readFileSync(path.join(PROBE_DIR, name), 'utf8');
}

function walk(root, predicate, output = []) {
  if (!existsSync(root)) return output;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) walk(target, predicate, output);
    else if (entry.isFile() && predicate(target)) output.push(target);
  }
  return output;
}

function productionJavaScript() {
  return JS_ROOTS.flatMap((root) => walk(
    path.join(REPO_ROOT, root),
    (file) => JS_EXTENSIONS.has(path.extname(file).toLowerCase())
      && !/\.(?:test|spec)\.(?:js|mjs|cjs)$/i.test(file),
  )).sort();
}

function productionByExtension(extension) {
  return walk(
    REPO_ROOT,
    (file) => path.extname(file).toLowerCase() === extension,
  ).sort();
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function lineSnippet(source, index) {
  const start = source.lastIndexOf('\n', index - 1) + 1;
  const end = source.indexOf('\n', index);
  return source.slice(start, end < 0 ? source.length : end).trim();
}

function violation(file, source, index, rule) {
  return `${file}:${lineNumber(source, index)} [${rule}] ${JSON.stringify(lineSnippet(source, index))}`;
}

function matches(source, expression) {
  const found = [];
  expression.lastIndex = 0;
  let match;
  while ((match = expression.exec(source)) !== null) {
    found.push(match);
    if (match[0].length === 0) expression.lastIndex += 1;
  }
  return found;
}

function findUnsafeCalls(source) {
  const calls = [];
  const expression = /\b(unsafeRaw[A-Za-z0-9_]*)\s*\(/g;
  for (const match of matches(source, expression)) {
    const prefix = source.slice(Math.max(0, match.index - 40), match.index);
    if (/(?:function|def)\s+$/.test(prefix)) continue;
    let depth = 0;
    let quote = null;
    let escaped = false;
    let end = match.index;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (quote !== null) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        continue;
      }
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    calls.push({
      accessor: match[1],
      index: match.index,
      text: source.slice(match.index, end),
    });
  }
  return calls;
}

function callArguments(callText) {
  const open = callText.indexOf('(');
  const close = callText.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const argumentsFound = [];
  let start = open + 1;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < close; index += 1) {
    const char = callText[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      argumentsFound.push(callText.slice(start, index).trim());
      start = index + 1;
    }
  }
  argumentsFound.push(callText.slice(start, close).trim());
  while (argumentsFound.at(-1) === '') argumentsFound.pop();
  return argumentsFound;
}

function literalReason(callText) {
  const argument = callArguments(callText).at(-1) || '';
  const match = argument.match(/^(['"`])([\s\S]*)\1$/);
  if (!match || (match[1] === '`' && match[2].includes('${'))) return null;
  return match[2]
    .replace(/\\(['"\\`])/g, '$1')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function maskJavaScriptNonCode(source) {
  let masked = '';
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let templateText = false;
  let templateExpressionDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (templateText) {
      if (escaped) {
        escaped = false;
        masked += char === '\n' ? '\n' : ' ';
      } else if (char === '\\') {
        escaped = true;
        masked += ' ';
      } else if (char === '`') {
        templateText = false;
        masked += ' ';
      } else if (char === '$' && next === '{') {
        templateText = false;
        templateExpressionDepth = 1;
        masked += '${';
        index += 1;
      } else {
        masked += char === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        masked += '\n';
      } else {
        masked += ' ';
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        masked += '  ';
        index += 1;
        blockComment = false;
      } else {
        masked += char === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (quote !== null) {
      masked += char === '\n' ? '\n' : ' ';
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      masked += '  ';
      index += 1;
      lineComment = true;
    } else if (char === '/' && next === '*') {
      masked += '  ';
      index += 1;
      blockComment = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      masked += ' ';
    } else if (char === '`') {
      if (templateExpressionDepth > 0) quote = char;
      else templateText = true;
      masked += ' ';
    } else {
      masked += char;
      if (templateExpressionDepth > 0 && char === '{') {
        templateExpressionDepth += 1;
      } else if (templateExpressionDepth > 0 && char === '}') {
        templateExpressionDepth -= 1;
        if (templateExpressionDepth === 0) templateText = true;
      }
    }
  }
  return masked;
}

function unsafeSpecialIndirections(source) {
  return [
    ...matches(source, /\bunsafeRaw[A-Za-z0-9_]*\s+as\s+[A-Za-z_$][\w$]*/g),
    ...matches(source, /\bunsafeRaw[A-Za-z0-9_]*\s*:\s*[A-Za-z_$][\w$]*/g),
    ...matches(source, /\bunsafeRaw[A-Za-z0-9_]*\s*\.\s*(?:call|apply|bind)\s*\(/g),
    ...matches(source, /\(\s*unsafeRaw[A-Za-z0-9_]*\s*\)\s*\(/g),
    ...matches(source, /\bunsafeRaw[A-Za-z0-9_]*\s*\?\.\s*\(/g),
    ...matches(source, /\[\s*['"]unsafeRaw[A-Za-z0-9_]*['"]\s*\]/g),
    ...matches(source, /\.\s*unsafeRaw[A-Za-z0-9_]*\s*(?:\?\.\s*)?\(/g),
    ...matches(
      source,
      /\bReflect\s*\.\s*get\s*\([^,\r\n]+,\s*['"`]unsafeRaw[A-Za-z0-9_]*['"`]/g,
    ),
    ...matches(
      source,
      /\bObject\s*\.\s*getOwnPropertyDescriptor\s*\([^,\r\n]+,\s*['"`]unsafeRaw[A-Za-z0-9_]*['"`]/g,
    ),
  ];
}

function unsafeJavaScriptIndirections(source) {
  return [
    ...unsafeSpecialIndirections(source),
    // A non-call identifier use can alias or escape the raw reader regardless
    // of the declaration or statement surface around it.
    ...unsafeTokenViolations(source),
  ];
}

function unsafePythonIndirections(source) {
  return [
    ...unsafeSpecialIndirections(source),
    ...matches(
      source,
      /^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?unsafeRaw[A-Za-z0-9_]*\b(?!\s*\()/gm,
    ),
  ];
}

function unsafeTokenViolations(source) {
  const code = maskJavaScriptNonCode(source);
  const allowedSpans = [];
  const allow = (expression) => {
    for (const match of matches(code, expression)) {
      allowedSpans.push([match.index, match.index + match[0].length]);
    }
  };
  allow(/\b(?:export\s+)?(?:async\s+)?function\s+unsafeRaw[A-Za-z0-9_]*\s*\(/g);
  allow(/\bimport\s*\{[\s\S]{0,2000}?\}\s*from\b/g);
  allow(/\b(?:export\s+)?(?:const|let|var)\s*\{[\s\S]{0,2000}?\}\s*=/g);
  allow(/\bexport\s*\{[\s\S]{0,2000}?\}(?:\s*from\b)?/g);
  for (const call of findUnsafeCalls(source)) {
    allowedSpans.push([call.index, call.index + call.accessor.length]);
  }

  return matches(code, /\bunsafeRaw[A-Za-z0-9_]*\b/g).filter((match) => (
    !allowedSpans.some(([start, end]) => match.index >= start && match.index < end)
  ));
}

function findSafeReaderCalls(source) {
  const calls = [];
  const expression = /\b(scalar|capsuleValue|bodySection|frontmatterList|collapseLineBreaking)\s*\(/g;
  for (const match of matches(source, expression)) {
    calls.push({
      accessor: match[1],
      index: match.index,
      text: lineSnippet(source, match.index),
    });
  }
  return calls;
}

function safeReaderIndirections(source) {
  const name = '(?:scalar|capsuleValue|bodySection|frontmatterList|collapseLineBreaking)';
  const object = '[A-Za-z_$][\\w$]*';
  return [
    ...matches(source, new RegExp(`\\b${name}\\s+as\\s+[A-Za-z_$][\\w$]*`, 'g')),
    ...matches(source, new RegExp(`\\b${name}\\s*:\\s*[A-Za-z_$][\\w$]*`, 'g')),
    ...matches(
      source,
      new RegExp(
        `\\b(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*=\\s*${name}\\b(?!\\s*\\()`,
        'g',
      ),
    ),
    ...matches(
      source,
      new RegExp(
        `\\b(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*=\\s*[A-Za-z_$][\\w$]*\\s*\\.\\s*${name}\\b`,
        'g',
      ),
    ),
    ...matches(source, new RegExp(`\\(\\s*${name}\\s*\\)\\s*\\(`, 'g')),
    ...matches(
      source,
      new RegExp(
        `(?:\\b${object}\\s*(?:\\?\\.|\\.)\\s*)?\\b${name}`
          + '\\s*(?:\\?\\.|\\.)\\s*(?:call|apply|bind)\\s*\\(',
        'g',
      ),
    ),
    ...matches(
      source,
      new RegExp(
        `(?:\\b${object}\\s*(?:\\?\\.|\\.)\\s*)?\\b${name}\\s*\\?\\.\\s*\\(`,
        'g',
      ),
    ),
    ...matches(
      source,
      new RegExp(`\\b${object}\\s*\\?\\.\\s*${name}\\s*\\(`, 'g'),
    ),
    ...matches(
      source,
      new RegExp(
        `\\b${object}\\s*(?:\\?\\.\\s*)?\\[\\s*['"\\x60]${name}['"\\x60]\\s*\\]`
          + '\\s*(?:(?:\\?\\.|\\.)\\s*(?:call|apply|bind)\\s*|\\?\\.\\s*)?\\(',
        'g',
      ),
    ),
  ];
}

function readFileAliases(source) {
  const code = maskJavaScriptNonCode(source);
  const aliases = new Set(['readFile', 'readFileSync']);
  const findings = [
    ...matches(code, /\b(?:readFileSync|readFile)\s+as\s+[A-Za-z_$][\w$]*/g),
    ...matches(code, /\b(?:readFileSync|readFile)\s*:\s*[A-Za-z_$][\w$]*/g),
    ...matches(
      code,
      /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:(?:[A-Za-z_$][\w$]*|\])\s*(?:\?\.|\.)\s*)*(?:readFileSync|readFile)\b(?!\s*\()/g,
    ),
  ];
  for (const match of matches(
    source,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*(?:\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*)*\s*(?:\?\.\s*)?\[\s*['"`](?:readFileSync|readFile)['"`]\s*\]/g,
  )) {
    if (code[match.index] === ' ') continue;
    aliases.add(match[1]);
    findings.push(match);
  }
  for (const match of matches(
    source,
    /\bReflect\s*\.\s*get\s*\([^,\r\n]+,\s*['"`](?:readFileSync|readFile)['"`]\s*\)/g,
  )) {
    if (code[match.index] !== ' ') findings.push(match);
  }
  for (const match of matches(
    code,
    /\b(?:readFileSync|readFile)\s+(?:as|:)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    aliases.add(match[1]);
  }
  for (const match of matches(
    code,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(?:[A-Za-z_$][\w$]*|\])\s*(?:\?\.|\.)\s*)*(?:readFileSync|readFile)\b(?!\s*\()/g,
  )) {
    aliases.add(match[1]);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of matches(
      code,
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b(?!\s*\()/g,
    )) {
      if (aliases.has(match[2]) && !aliases.has(match[1])) {
        aliases.add(match[1]);
        findings.push(match);
        changed = true;
      }
    }
  }
  return { aliases, findings };
}

function endOfCall(source, open) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

function findReadCalls(source, aliases) {
  const code = maskJavaScriptNonCode(source);
  const calls = [];
  const expression = /\b((?:(?:[A-Za-z_$][\w$]*|\])\s*(?:\?\.\s*|\.\s*))*([A-Za-z_$][\w$]*))\s*\(/g;
  for (const match of matches(code, expression)) {
    if (!aliases.has(match[2])) continue;
    const open = match.index + match[0].lastIndexOf('(');
    calls.push({
      index: match.index,
      open,
      end: endOfCall(source, open),
      text: source.slice(match.index, endOfCall(source, open)),
    });
  }
  const bracketExpression = /\b[A-Za-z_$][\w$]*(?:\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*)*\s*(?:\?\.\s*)?\[\s*['"`](readFileSync|readFile)['"`]\s*\]\s*(?:\?\.\s*)?\(/g;
  for (const match of matches(source, bracketExpression)) {
    if (code[match.index] === ' ') continue;
    const open = match.index + match[0].lastIndexOf('(');
    const end = endOfCall(source, open);
    calls.push({
      index: match.index,
      open,
      end,
      text: source.slice(match.index, end),
    });
  }
  return calls;
}

function rawReadInterpolations(source) {
  const findings = [];
  const { aliases } = readFileAliases(source);
  const readCalls = findReadCalls(source, aliases);
  const assigned = [];
  for (const call of readCalls) {
    const prefix = source.slice(Math.max(0, call.index - 500), call.index);
    const assignment = prefix.match(
      /(?:\b(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/,
    );
    if (assignment) assigned.push({ name: assignment[1], call });

    const statementStart = Math.max(
      source.lastIndexOf(';', call.index - 1),
      call.index - 1000,
    );
    const before = source.slice(statementStart + 1, call.index);
    const nextSemicolon = source.indexOf(';', call.end);
    const statementEnd = nextSemicolon < 0
      ? Math.min(source.length, call.end + 1000)
      : Math.min(nextSemicolon, call.end + 1000);
    const after = source.slice(call.end, statementEnd);
    const directSink = /\$\{[^}]{0,600}$/.test(before)
      || /\+\s*(?:await\s+)?$/.test(before)
      || /^\s*\+/.test(after)
      || /^\s*\.concat\s*\(/.test(after)
      || /(?:\.\s*(?:push|unshift|append|concat|write|writeSync|end|send)\s*\(|\b(?:writeSync|writeFileSync|writeFile|appendFileSync|appendFile)\s*\()[^;]{0,600}$/.test(before);
    if (directSink) findings.push({ index: call.index, 0: call.text });
  }

  for (const assignment of assigned) {
    const variable = assignment.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let reachedSink = false;
    const interpolation = new RegExp(`\\$\\{[^}\\n]{0,500}\\b${variable}\\b[^}\\n]{0,500}\\}`, 'g');
    for (const match of matches(source, interpolation)) {
      findings.push(match);
      reachedSink = true;
    }
    const sinks = [
      new RegExp(`\\b${variable}\\b\\s*\\+(?![+=])|\\+\\s*\\b${variable}\\b`, 'g'),
      new RegExp(`\\+=\\s*\\b${variable}\\b`, 'g'),
      new RegExp(
        `\\.\\s*(?:push|unshift|append|concat)\\s*\\([^;]{0,500}\\b${variable}\\b`,
        'g',
      ),
      new RegExp(`\\b${variable}\\b\\s*\\.\\s*concat\\s*\\(`, 'g'),
      new RegExp(
        `(?:\\.\\s*(?:write|writeSync|end|send)\\s*\\(|`
          + '\\b(?:writeSync|writeFileSync|writeFile|appendFileSync|appendFile)\\s*\\()'
          + `[^;]{0,500}\\b${variable}\\b`,
        'g',
      ),
    ];
    for (const sink of sinks) {
      const sinkMatches = matches(source, sink);
      if (sinkMatches.length > 0) reachedSink = true;
      findings.push(...sinkMatches);
    }
    if (reachedSink) {
      findings.push({
        index: assignment.call.index,
        0: assignment.call.text,
      });
    }
  }
  return findings;
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function javascriptTemplateExpressions(source, start = 0, end = source.length) {
  const code = maskJavaScriptNonCode(source);
  const expressions = [];
  let cursor = start;
  while (cursor < end) {
    const index = code.indexOf('${', cursor);
    if (index < 0 || index >= end) break;
    let depth = 1;
    let close = index + 2;
    for (; close < code.length && depth > 0; close += 1) {
      if (code[close] === '{') depth += 1;
      else if (code[close] === '}') depth -= 1;
    }
    if (depth !== 0) break;
    expressions.push({
      index,
      text: source.slice(index + 2, close - 1),
    });
    cursor = close;
  }
  return expressions;
}

function javascriptBlockEnd(source, index) {
  const code = maskJavaScriptNonCode(source);
  let depth = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (code[cursor] === '{') depth += 1;
    else if (code[cursor] === '}') depth -= 1;
  }
  const startingDepth = depth;
  for (let cursor = index; cursor < code.length; cursor += 1) {
    if (code[cursor] === '{') depth += 1;
    else if (code[cursor] === '}') {
      depth -= 1;
      if (depth < startingDepth) return cursor;
    }
  }
  return source.length;
}

function isWholeCallExpression(expression, accessor) {
  const trimmed = expression.trim();
  const match = new RegExp(`^${regexEscape(accessor)}\\s*\\(`).exec(trimmed);
  if (!match) return false;
  const open = trimmed.indexOf('(', match.index);
  return endOfCall(trimmed, open) === trimmed.length;
}

function isInertJavaScriptExpression(expression) {
  return isWholeCallExpression(expression, 'inert');
}

function isWholeLengthExpression(expression, name) {
  const escaped = regexEscape(name);
  const member = '(?:\\s*(?:\\?\\.|\\.)\\s*[A-Za-z_$][\\w$]*'
    + '|\\s*(?:\\?\\.)?\\[[^\\]\\r\\n]+\\])';
  return new RegExp(
    `^\\s*${escaped}(?:${member})*`
      + '\\s*(?:\\?\\.|\\.)\\s*length'
      + '\\s*(?:(?:\\?\\?|\\|\\|)\\s*\\d+)?\\s*$',
  ).test(expression);
}

function javascriptVariableRenderUses(
  source,
  name,
  start,
  end,
  { properties = null } = {},
) {
  const escaped = regexEscape(name);
  const reference = properties === null
    ? new RegExp(`\\b${escaped}\\b`)
    : new RegExp(
      `\\b${escaped}\\b\\s*(?:\\?\\.\\s*|\\.\\s*)`
        + `(?:${properties.map(regexEscape).join('|')})\\b`,
    );
  return javascriptTemplateExpressions(source, start, end)
    .filter(({ text }) => !isInertJavaScriptExpression(text))
    .filter(({ text }) => reference.test(text))
    .filter(({ text }) => !isWholeLengthExpression(text, name));
}

function jsonReadInterpolations(source) {
  const findings = [];
  const { aliases } = readFileAliases(source);
  for (const call of findReadCalls(source, aliases)) {
    const prefixStart = Math.max(0, call.index - 1_500);
    const prefix = source.slice(prefixStart, call.index);
    const assignment = prefix.match(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*JSON\s*\.\s*parse\s*\([^;{}]{0,1200}$/,
    );
    if (!assignment) continue;
    const assignmentIndex = prefixStart + assignment.index;
    findings.push(...javascriptVariableRenderUses(
      source,
      assignment[1],
      call.end,
      javascriptBlockEnd(source, assignmentIndex),
    ));
  }
  return findings;
}

function expressionDelimiterParsers(source) {
  const code = maskJavaScriptNonCode(source);
  const findings = [];
  for (const binding of matches(
    source,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])-\2\s*\.\s*repeat\s*\(\s*3\s*\)/g,
  )) {
    if (code[binding.index] === ' ') continue;
    const name = regexEscape(binding[1]);
    const end = javascriptBlockEnd(source, binding.index);
    const use = new RegExp(
      `\\.\\s*(?:slice|substring)\\s*\\([^)]{0,160}\\)\\s*(?:={2,3}|!={1,2})\\s*${name}\\b`
        + `|\\b${name}\\b\\s*(?:={2,3}|!={1,2})\\s*[^;\\r\\n]{0,200}`
          + '\\.\\s*(?:slice|substring)\\s*\\('
        + `|\\.\\s*(?:split|indexOf|startsWith)\\s*\\(\\s*${name}\\b`,
      'g',
    );
    use.lastIndex = binding.index + binding[0].length;
    let match;
    while ((match = use.exec(code)) !== null && match.index < end) {
      findings.push(match);
    }
  }
  return findings;
}

function childProcessInterpolations(source) {
  const code = maskJavaScriptNonCode(source);
  const findings = [];
  const calls = /\b(execSync|spawnSync)\s*\(/g;
  for (const match of matches(code, calls)) {
    const open = match.index + match[0].lastIndexOf('(');
    const end = endOfCall(source, open);
    const prefixStart = Math.max(0, match.index - 500);
    const prefix = source.slice(prefixStart, match.index);
    const assignment = prefix.match(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/,
    );
    if (!assignment) continue;
    const assignmentIndex = prefixStart + assignment.index;
    const scopeEnd = javascriptBlockEnd(source, assignmentIndex);
    if (match[1] === 'execSync') {
      findings.push(...javascriptVariableRenderUses(
        source,
        assignment[1],
        end,
        scopeEnd,
      ));
      continue;
    }

    const semicolon = source.indexOf(';', end);
    const suffixEnd = semicolon < 0 ? Math.min(source.length, end + 200) : semicolon;
    const suffix = source.slice(end, suffixEnd);
    if (/^\s*(?:\?\.|\.)\s*(?:stdout|stderr|output)\b/.test(suffix)) {
      findings.push(...javascriptVariableRenderUses(
        source,
        assignment[1],
        suffixEnd,
        scopeEnd,
      ));
    } else {
      findings.push(...javascriptVariableRenderUses(
        source,
        assignment[1],
        end,
        scopeEnd,
        { properties: ['stdout', 'stderr', 'output'] },
      ));
    }
  }

  for (const expression of javascriptTemplateExpressions(source)) {
    if (isInertJavaScriptExpression(expression.text)) continue;
    const expressionCode = maskJavaScriptNonCode(expression.text);
    let directOutput = /\bexecSync\s*\(/.test(expressionCode);
    for (const call of matches(expressionCode, /\bspawnSync\s*\(/g)) {
      const open = call.index + call[0].lastIndexOf('(');
      const end = endOfCall(expression.text, open);
      if (/^\s*(?:\?\.|\.)\s*(?:stdout|stderr|output)\b/.test(
        expression.text.slice(end),
      )) {
        directOutput = true;
      }
    }
    if (directOutput) {
      findings.push(expression);
    }
  }
  return findings;
}

function environmentInterpolations(source) {
  return javascriptTemplateExpressions(source)
    .filter(({ text }) => !isInertJavaScriptExpression(text))
    .filter(({ text }) => (
      /\bprocess\s*\.\s*env\s*(?:(?:\?\.|\.)\s*[A-Za-z_$][\w$]*|(?:\?\.\s*)?\[[^\]\r\n]+\])/.test(text)
    ));
}

function maskPythonNonCode(source) {
  let masked = '';
  let quote = null;
  let triple = false;
  let escaped = false;
  let comment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (comment) {
      if (char === '\n') {
        comment = false;
        masked += '\n';
      } else {
        masked += ' ';
      }
      continue;
    }
    if (quote !== null) {
      if (triple
        && !escaped
        && char === quote
        && source[index + 1] === quote
        && source[index + 2] === quote) {
        masked += '   ';
        index += 2;
        quote = null;
        triple = false;
      } else {
        masked += char === '\n' ? '\n' : ' ';
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (!triple && char === quote) quote = null;
      }
      continue;
    }
    if (char === '#') {
      comment = true;
      masked += ' ';
    } else if (char === '"' || char === "'") {
      quote = char;
      triple = source[index + 1] === char && source[index + 2] === char;
      masked += triple ? '   ' : ' ';
      if (triple) index += 2;
    } else {
      masked += char;
    }
  }
  return masked;
}

function pythonScopeEnd(source, index, code = maskPythonNonCode(source)) {
  const starts = [0];
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\n') starts.push(cursor + 1);
  }
  let lineIndex = starts.length - 1;
  while (lineIndex > 0 && starts[lineIndex] > index) lineIndex -= 1;
  const lineAt = (line) => {
    const end = source.indexOf('\n', starts[line]);
    return {
      code: code.slice(starts[line], end < 0 ? source.length : end),
      source: source.slice(starts[line], end < 0 ? source.length : end),
    };
  };
  const bindingLine = lineAt(lineIndex).source;
  const bindingIndent = bindingLine.match(/^[ \t]*/)[0].length;
  let searchIndent = bindingIndent;
  let scopeIndent = null;
  let scopeLine = null;
  for (let line = lineIndex - 1; line >= 0; line -= 1) {
    const candidate = lineAt(line);
    if (!candidate.code.trim()) continue;
    const indent = candidate.source.match(/^[ \t]*/)[0].length;
    if (indent >= searchIndent) continue;
    const trimmed = candidate.code.trim();
    if (/^(?:(?:async\s+)?def|class)\b[^:]*:\s*$/.test(trimmed)) {
      scopeIndent = indent;
      scopeLine = line;
      break;
    }
    searchIndent = indent;
    if (searchIndent === 0) break;
  }
  if (scopeLine === null) return source.length;
  for (let line = scopeLine + 1; line < starts.length; line += 1) {
    const candidate = lineAt(line);
    if (!candidate.code.trim()) continue;
    const indent = candidate.source.match(/^[ \t]*/)[0].length;
    if (indent <= scopeIndent) return starts[line];
  }
  return source.length;
}

function pythonFStringExpressions(source) {
  const code = maskPythonNonCode(source);
  const expressions = [];
  const starts = /\b(?:f|fr|rf)("""|'''|"|')/gi;
  for (const string of matches(source, starts)) {
    if (code[string.index] === ' ') continue;
    const quote = string[1];
    const bodyStart = string.index + string[0].length;
    let bodyEnd = bodyStart;
    let escaped = false;
    while (bodyEnd < source.length) {
      if (!escaped && source.startsWith(quote, bodyEnd)) break;
      if (escaped) escaped = false;
      else if (source[bodyEnd] === '\\') escaped = true;
      bodyEnd += 1;
    }
    if (bodyEnd >= source.length) continue;

    let cursor = bodyStart;
    while (cursor < bodyEnd) {
      const open = source.indexOf('{', cursor);
      if (open < 0 || open >= bodyEnd) break;
      if (source[open + 1] === '{') {
        cursor = open + 2;
        continue;
      }
      let depth = 1;
      let close = open + 1;
      let expressionQuote = null;
      let expressionEscaped = false;
      for (; close < bodyEnd && depth > 0; close += 1) {
        const char = source[close];
        if (expressionQuote !== null) {
          if (expressionEscaped) expressionEscaped = false;
          else if (char === '\\') expressionEscaped = true;
          else if (char === expressionQuote) expressionQuote = null;
        } else if (char === '"' || char === "'") {
          expressionQuote = char;
        } else if (char === '{') {
          depth += 1;
        } else if (char === '}') {
          depth -= 1;
        }
      }
      if (depth !== 0) break;
      expressions.push({
        index: open,
        text: source.slice(open + 1, close - 1),
      });
      cursor = close;
    }
    starts.lastIndex = bodyEnd + quote.length;
  }
  return expressions;
}

const PYTHON_LINE_STRING = String.raw`(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')`;

function pythonVariableRenderUses(source, expressions, name, start, end) {
  const findings = expressions
    .filter(({ index }) => index > start && index < end)
    .filter(({ text }) => !isWholeCallExpression(text, 'inert'))
    .filter(({ text }) => new RegExp(`\\b${regexEscape(name)}\\b`).test(text));
  const code = maskPythonNonCode(source);
  const variable = regexEscape(name);
  const renderPatterns = [
    {
      expression: new RegExp(
        `${PYTHON_LINE_STRING}\\s*\\.\\s*format\\s*\\([^\\r\\n]*\\b${variable}\\b[^\\r\\n]*\\)`,
        'g',
      ),
      codeUse: new RegExp(`\\.\\s*format\\s*\\([^\\r\\n]*\\b${variable}\\b`),
    },
    {
      expression: new RegExp(
        `${PYTHON_LINE_STRING}\\s*\\+\\s*\\b${variable}\\b`
          + `|\\b${variable}\\b\\s*\\+\\s*${PYTHON_LINE_STRING}`,
        'g',
      ),
      codeUse: new RegExp(
        `\\+\\s*\\b${variable}\\b|\\b${variable}\\b\\s*\\+`,
      ),
    },
  ];
  for (const { expression, codeUse } of renderPatterns) {
    for (const match of matches(source, expression)) {
      if (match.index <= start || match.index >= end) continue;
      const masked = code.slice(match.index, match.index + match[0].length);
      if (codeUse.test(masked)) findings.push(match);
    }
  }
  return findings;
}

function pythonReadInterpolations(source) {
  const code = maskPythonNonCode(source);
  const findings = [];
  const expressions = pythonFStringExpressions(source);
  for (const assignment of matches(
    source,
    /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]*:[^=\r\n]+)?\s*=\s*open\s*\([^\r\n]*\)\s*\.\s*read\s*\(\s*\)/gm,
  )) {
    if (code[assignment.index] === ' ') continue;
    const variable = new RegExp(`\\b${regexEscape(assignment[1])}\\b`);
    const scopeEnd = pythonScopeEnd(source, assignment.index, code);
    findings.push(...expressions
      .filter(({ index }) => index > assignment.index && index < scopeEnd)
      .filter(({ text }) => !isWholeCallExpression(text, 'inert'))
      .filter(({ text }) => variable.test(text)));
  }
  findings.push(...expressions.filter(({ text }) => (
    !isWholeCallExpression(text, 'inert')
      && /\bopen\s*\([^\r\n]*\)\s*\.\s*read\s*\(\s*\)/.test(text)
  )));
  for (const context of matches(
    source,
    /^[ \t]*(?:async[ \t]+)?with[ \t]+open\s*\([^\r\n]*\)[ \t]+as[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*:/gm,
  )) {
    const firstToken = context.index + context[0].search(/\S/);
    if (code[firstToken] === ' ') continue;
    const handle = regexEscape(context[1]);
    const scopeEnd = pythonScopeEnd(source, context.index, code);
    const read = new RegExp(
      `\\b([A-Za-z_][A-Za-z0-9_]*)(?:\\s*:[^=\\r\\n]+)?`
        + `\\s*=\\s*${handle}\\s*\\.\\s*read(?:lines)?\\s*\\(\\s*\\)`,
      'g',
    );
    read.lastIndex = context.index + context[0].length;
    let match;
    while ((match = read.exec(code)) !== null && match.index < scopeEnd) {
      findings.push(...pythonVariableRenderUses(
        source,
        expressions,
        match[1],
        match.index + match[0].length,
        scopeEnd,
      ));
    }
  }
  return findings;
}

function shellHasPipeline(line) {
  for (const sourceLine of line.split(/\r?\n/)) {
    const code = shellCodeOnlyLine(sourceLine);
    for (let index = 0; index < code.length; index += 1) {
      if (code[index] === '|'
        && code[index - 1] !== '|'
        && code[index + 1] !== '|') {
        return true;
      }
    }
  }
  return false;
}

function continuedShellCommand(source, index, firstLine) {
  let command = firstLine;
  let line = firstLine;
  let cursor = index + firstLine.length;
  while (shellCodeOnlyLine(line).trimEnd().endsWith('\\')) {
    if (source[cursor] === '\r') cursor += 1;
    if (source[cursor] !== '\n') break;
    cursor += 1;
    const end = source.indexOf('\n', cursor);
    line = source.slice(cursor, end < 0 ? source.length : end).replace(/\r$/, '');
    command += `\n${line}`;
    cursor = end < 0 ? source.length : end;
  }
  return command;
}

function shellReadInterpolations(source) {
  const findings = [];
  for (const assignment of matches(
    source,
    /^[ \t]*(?:(?:local|declare|readonly)[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:"|')?\$\([ \t]*cat\b([^\r\n)]*)\)(?:"|')?[ \t]*$/gm,
  )) {
    const operand = assignment[2]
      .replace(/[0-9]*>[>&]?[^\s]*/g, '')
      .trim();
    if (!operand) continue;
    const variable = regexEscape(assignment[1]);
    const sink = new RegExp(
      `^[^\\r\\n]*\\bprintf\\b[^\\r\\n]*\\$(?:\\{${variable}\\}|${variable}\\b)[^\\r\\n]*$`,
      'gm',
    );
    sink.lastIndex = assignment.index + assignment[0].length;
    let match;
    while ((match = sink.exec(source)) !== null) {
      const code = shellCodeOnlyLine(match[0]);
      if (!/\bprintf\b/.test(code)) continue;
      if (/\bprintf\b[ \t]+(?:--[ \t]+)?-v(?:[ \t]|$)/.test(code)) continue;
      if (shellHasPipeline(continuedShellCommand(source, match.index, match[0]))) continue;
      findings.push(match);
    }
  }
  for (const line of matches(source, /^[^\r\n]*$/gm)) {
    const code = shellCodeOnlyLine(line[0]);
    if (!/^[ \t]*(?:(?:command|builtin)[ \t]+)?(?:echo|printf)\b/.test(code)) continue;
    if (/\bprintf\b[ \t]+(?:--[ \t]+)?-v(?:[ \t]|$)/.test(code)) continue;
    if (shellHasPipeline(continuedShellCommand(source, line.index, line[0]))) continue;
    for (const substitution of shellFileReadSubstitutions(line[0])) {
      findings.push({
        index: line.index + substitution.index,
        0: substitution.text,
      });
    }
  }
  return findings;
}

function shellFileReadSubstitutions(line) {
  const substitutions = [];
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (char === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote === null
      && char === '#'
      && (index === 0 || /[\s;|&()]/.test(line[index - 1]))) {
      break;
    }
    if (char !== '$' || line[index + 1] !== '(' || line[index + 2] === '(') {
      continue;
    }

    let innerQuote = null;
    let innerEscaped = false;
    let depth = 1;
    let end = index + 2;
    for (; end < line.length && depth > 0; end += 1) {
      const inner = line[end];
      if (innerEscaped) {
        innerEscaped = false;
      } else if (inner === '\\' && innerQuote !== "'") {
        innerEscaped = true;
      } else if (innerQuote !== null) {
        if (inner === innerQuote) innerQuote = null;
      } else if (inner === '"' || inner === "'") {
        innerQuote = inner;
      } else if (inner === '(') {
        depth += 1;
      } else if (inner === ')') {
        depth -= 1;
      }
    }
    if (depth !== 0) break;
    const text = line.slice(index, end);
    const read = text.match(/^\$\([ \t]*(?:cat\b([^\r\n)]*)|<([^\r\n)]*))\)$/);
    if (read) {
      const operand = (read[1] ?? read[2] ?? '')
        .replace(/[0-9]*>[>&]?[^\s]*/g, '')
        .trim();
      if (operand) substitutions.push({ index, text });
    }
    index = end - 1;
  }
  return substitutions;
}

function pythonVariableDelimiterParsers(source) {
  const code = maskPythonNonCode(source);
  const findings = [];
  for (const binding of matches(
    source,
    /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]*:[^=\r\n]+)?\s*=\s*(?:(["'])---\2|(["'])-\3\s*\*\s*3|(["'])--\4\s*\+\s*(["'])-\5)[ \t]*$/gm,
  )) {
    const firstToken = binding.index + binding[0].search(/\S/);
    if (code[firstToken] === ' ') continue;
    const variable = regexEscape(binding[1]);
    const scopeEnd = pythonScopeEnd(source, binding.index, code);
    const use = new RegExp(
      `\\.\\s*(?:split|partition|find|startswith)\\s*\\(\\s*${variable}\\b`,
      'g',
    );
    use.lastIndex = binding.index + binding[0].length;
    let match;
    while ((match = use.exec(code)) !== null && match.index < scopeEnd) {
      findings.push(match);
    }
  }
  return findings;
}

// Selector and consume operations need the complete capsule document so the
// shared reader can inspect fields and preserve all unrelated bytes.
const JS_RAW_ALLOWLIST = [
  {
    file: 'daemons/lifecycle-common.mjs',
    accessor: 'unsafeRawCapsuleDocument',
    reason: 'capsule selection needs the complete document for shared field readers',
  },
  {
    file: 'daemons/lifecycle-common.mjs',
    accessor: 'unsafeRawCapsuleDocument',
    reason: 'status mutation preserves the complete capsule outside the active frontmatter token',
  },
  {
    file: 'daemons/lifecycle-common.mjs',
    accessor: 'unsafeRawRewriteScalar',
    reason: 'consume transition preserves every byte outside the leading status scalar',
  },
  // Pointer stamping reads a full document but exports only safe shared-reader
  // scalars into BODY_STATE.json.
  {
    file: 'daemons/curated-close-pointer.mjs',
    accessor: 'unsafeRawCapsuleDocument',
    reason: 'curated pointer stamping returns only shared-reader scalars from this capsule',
  },
  // Resume and warm orientation acquire bytes before every rendered field goes
  // through the shared reader and inert boundary.
  {
    file: 'daemons/resume-verb.mjs',
    accessor: 'unsafeRawCapsuleDocument',
    reason: 'resume loads the selected capsule before returning only shared-reader values',
  },
  {
    file: 'daemons/sessionstart-reinject.mjs',
    accessor: 'unsafeRawCapsuleDocument',
    reason: 'warm orientation reads the selected capsule before returning only shared-reader values',
  },
  // identity-core is the one intentional, operator-authored multiline procedure
  // loaded during warm orientation.
  {
    file: 'daemons/sessionstart-reinject.mjs',
    accessor: 'unsafeRawMemoryDocument',
    reason: 'identity-core is operator-authored procedure text whose multiline structure is intentional',
  },
  {
    file: 'daemons/sessionstart-reinject.mjs',
    accessor: 'unsafeRawMemoryDocument',
    reason: 'session-log orientation selects one heading and renders it through inert',
  },
  // Decision-outcome updates replace one audited block while preserving all
  // other operator-authored ledger sections byte for byte.
  {
    file: 'daemons/nightly-decision-outcome.mjs',
    accessor: 'unsafeRawMemoryDocument',
    reason: 'nightly decision matching parses authored ledger entries without rendering the document',
  },
  {
    file: 'daemons/nightly-decision-outcome.mjs',
    accessor: 'unsafeRawMemoryDocument',
    reason: 'nightly outcome updates preserve authored ledger sections outside the targeted decision',
  },
  {
    file: 'daemons/nightly-decision-outcome.mjs',
    accessor: 'unsafeRawMemoryDocument',
    reason: 'nightly outcome compare-and-swap hashes exact authored ledger bytes without rendering them',
  },
  {
    file: 'daemons/nightly-decision-outcome.mjs',
    accessor: 'unsafeRawMemoryDocument',
    reason: 'nightly outcome post-write verification parses exact authored ledger bytes without rendering them',
  },
  // PreCompact renders only safe, quoted, bounded table-of-contents values.
  {
    file: 'daemons/precompact-flush.mjs',
    accessor: 'unsafeRawCapsuleDocument',
    reason: 'precompact builds a bounded table of contents from shared-reader capsule values',
  },
  {
    file: 'daemons/precompact-flush.mjs',
    accessor: 'unsafeRawBodySection',
    reason: 'precompact preserves authored gate rows but renders every row through inert',
  },
  // The stop writer is a byte-preserving document transformer for body sections
  // it does not own.
  {
    file: 'daemons/stop-capsule-writer.mjs',
    accessor: 'unsafeRawCapsuleDocument',
    reason: 'stop writer preserves unowned capsule body sections during anchored mutation',
  },
  // The transcript delta is multiline transport data. The stop writer parses
  // it before every stored field reaches the rendering boundary.
  {
    file: 'daemons/stop-capsule-writer.mjs',
    accessor: 'unsafeRawTranscriptDelta',
    reason: 'the stop writer parses the complete multiline transcript delta before rendering stored fields',
  },
  // Journal records intentionally preserve operator-authored source bytes;
  // later prompt consumers must still render extracted fields through inert.
  {
    file: 'daemons/userpromptsubmit-journal.mjs',
    accessor: 'unsafeRawJournalPrompt',
    reason: 'the write-ahead journal intentionally preserves the complete operator prompt',
  },
  {
    file: 'daemons/sessionend-flush.mjs',
    accessor: 'unsafeRawSessionEndReason',
    reason: 'the session-end journal intentionally preserves the complete lifecycle reason',
  },
  // Semantic indexing intentionally embeds authored paragraphs; metadata still
  // uses the safe scalar/list readers.
  {
    file: 'daemons/semantic-search/embed-vault.js',
    accessor: 'unsafeRawDocumentBody',
    reason: 'semantic indexing preserves authored note body paragraphs',
  },
];

// Safe readers remove line structure, but they do not replace inert()'s quoting
// and bounding job. Auditing every production reader call keeps a new direct
// interpolation from silently joining the trusted population.
const JS_SAFE_READER_ALLOWLIST = [
  {
    file: 'daemons/lifecycle-common.mjs',
    accessor: 'collapseLineBreaking',
    needle: "collapseLineBreaking(value ?? '')",
    reason: 'inert immediately bounds and JSON-quotes the collapsed value at the rendering boundary',
  },
  {
    file: 'daemons/lifecycle-common.mjs',
    accessor: 'collapseLineBreaking',
    needle: 'collapseLineBreaking(override)',
    reason: 'seat identity is collapsed and then either validated as a constrained token or replaced by a hash',
  },
  {
    file: 'daemons/nightly-alerts.mjs',
    accessor: 'collapseLineBreaking',
    needle: "collapseLineBreaking(value ?? '')",
    reason: 'alert persistence removes line controls before model-facing formatters render every field through inert',
  },
  {
    file: 'daemons/nightly-decision-outcome.mjs',
    accessor: 'collapseLineBreaking',
    needle: "collapseLineBreaking(value || '')",
    reason: 'decision matching removes line controls before the title and source reach inert rendering boundaries',
  },
  {
    file: 'daemons/capsule-verb.mjs',
    accessor: 'scalar',
    needle: 'scalar(text, field)',
    reason: 'capsule validation checks field presence and content without rendering it',
  },
  {
    file: 'daemons/curated-close-pointer.mjs',
    accessor: 'scalar',
    needle: 'scalar(doc, key)',
    reason: 'pointer metadata is persisted as state and every later prompt consumer renders it inert',
  },
  {
    file: 'daemons/lifecycle-common.mjs',
    accessor: 'scalar',
    needle: "scalar(doc, 'id')",
    reason: 'selection uses the identifier as metadata before downstream inert rendering',
  },
  {
    file: 'daemons/lifecycle-common.mjs',
    accessor: 'scalar',
    needle: "scalar(doc, 'created_at')",
    reason: 'selection parses the timestamp numerically rather than rendering source text',
  },
  {
    file: 'daemons/lifecycle-common.mjs',
    accessor: 'scalar',
    needle: "scalar(doc, 'status')",
    reason: 'selection compares the status token and never renders it as prompt structure',
  },
  {
    file: 'daemons/lifecycle-common.mjs',
    accessor: 'scalar',
    needle: "scalar(doc, 'trigger')",
    reason: 'rank classification tests the trigger token for equality and never renders it',
  },
  {
    file: 'daemons/lifecycle-common.mjs',
    accessor: 'scalar',
    needle: "scalar(doc, 'tags')",
    reason: 'rank classification regex-tests the tag list and never renders it',
  },
  {
    file: 'daemons/lifecycle-common.mjs',
    accessor: 'capsuleValue',
    needle: "capsuleValue(doc, 'objective')",
    reason: 'selection returns a single-line value whose prompt consumers apply inert',
  },
  {
    file: 'daemons/lifecycle-common.mjs',
    accessor: 'capsuleValue',
    needle: "capsuleValue(doc, 'next_valid_action')",
    reason: 'selection returns a single-line value whose prompt consumers apply inert',
  },
  {
    file: 'daemons/model-tier-guard.mjs',
    accessor: 'scalar',
    needle: "scalar(doc, 'name')",
    reason: 'the matched agent name is rendered only through inert in the advisory',
  },
  {
    file: 'daemons/model-tier-guard.mjs',
    accessor: 'scalar',
    needle: "scalar(doc, 'model')",
    reason: 'the declared model is rendered only through inert in the advisory',
  },
  {
    file: 'daemons/nightly-reconcile.mjs',
    accessor: 'frontmatterList',
    needle: "frontmatterList(text, 'aliases')",
    reason: 'aliases participate in normalized note matching and are not emitted as procedure text',
  },
  {
    file: 'daemons/nightly-route-check.mjs',
    accessor: 'scalar',
    needle: "scalar(text, 'status')",
    reason: 'route validation compares constrained status words and emits only fixed failures',
  },
  {
    file: 'daemons/precompact-flush.mjs',
    accessor: 'capsuleValue',
    needle: "capsuleValue(doc, 'objective')",
    reason: 'the precompact table of contents immediately renders this value through inert',
  },
  {
    file: 'daemons/precompact-flush.mjs',
    accessor: 'capsuleValue',
    needle: "capsuleValue(doc, 'next_valid_action')",
    reason: 'the precompact table of contents immediately renders this value through inert',
  },
  {
    file: 'daemons/precompact-flush.mjs',
    accessor: 'capsuleValue',
    needle: "capsuleValue(doc, 'waiting_on')",
    reason: 'the precompact table of contents immediately renders this value through inert',
  },
  {
    file: 'daemons/resume-verb.mjs',
    accessor: 'scalar',
    needle: "scalar(doc, 'id')",
    reason: 'the resume procedure renders the returned capsule identifier through inert',
  },
  {
    file: 'daemons/resume-verb.mjs',
    accessor: 'capsuleValue',
    needle: "capsuleValue(doc, 'objective')",
    reason: 'the resume procedure renders this single-line capsule value through inert',
  },
  {
    file: 'daemons/resume-verb.mjs',
    accessor: 'capsuleValue',
    needle: "capsuleValue(doc, 'waiting_on')",
    reason: 'the resume procedure renders this single-line capsule value through inert',
  },
  {
    file: 'daemons/resume-verb.mjs',
    accessor: 'capsuleValue',
    needle: "capsuleValue(doc, 'next_valid_action')",
    reason: 'the resume procedure renders this single-line capsule value through inert',
  },
  {
    file: 'daemons/resume-verb.mjs',
    accessor: 'scalar',
    needle: "scalar(doc, 'trigger')",
    reason: 'the trigger is compared to a fixed token and never rendered',
  },
  {
    file: 'daemons/resume-verb.mjs',
    accessor: 'scalar',
    needle: "scalar(doc, 'tags')",
    reason: 'tags determine an autosave label and are never rendered verbatim',
  },
  {
    file: 'daemons/sessionstart-reinject.mjs',
    accessor: 'capsuleValue',
    needle: "capsuleValue(doc, 'objective')",
    reason: 'warm orientation immediately renders this capsule value through inert',
  },
  {
    file: 'daemons/sessionstart-reinject.mjs',
    accessor: 'capsuleValue',
    needle: "capsuleValue(doc, 'next_valid_action')",
    reason: 'warm orientation immediately renders this capsule value through inert',
  },
  {
    file: 'daemons/sessionstart-reinject.mjs',
    accessor: 'capsuleValue',
    needle: "capsuleValue(doc, 'waiting_on')",
    reason: 'warm orientation immediately renders this capsule value through inert',
  },
  {
    file: 'daemons/stop-capsule-writer.mjs',
    accessor: 'scalar',
    needle: "scalar(doc, 'tags')",
    reason: 'the writer compares normalized ownership metadata and never renders it',
  },
  {
    file: 'daemons/stop-capsule-writer.mjs',
    accessor: 'scalar',
    needle: "scalar(doc, 'trigger')",
    reason: 'the writer compares normalized ownership metadata and never renders it',
  },
  {
    file: 'daemons/stop-capsule-writer.mjs',
    accessor: 'scalar',
    needle: "scalar(doc, 'objective')",
    reason: 'the final pointer persists a single-line value consumed through inert later',
  },
  {
    file: 'daemons/memory-heat/compute-heat.js',
    accessor: 'scalar',
    needle: "scalar(content, 'pin')",
    reason: 'the pin scalar controls a fixed scoring branch and is never rendered',
  },
  {
    file: 'daemons/memory-hygiene/resume-framing.mjs',
    accessor: 'scalar',
    needle: 'scalar(source, key)',
    reason: 'framing validation compares each value to a fixed contract token',
  },
  {
    file: 'daemons/semantic-search/embed-vault.js',
    accessor: 'scalar',
    needle: "scalar(content, 'title')",
    reason: 'the title remains single-line embedding metadata rather than prompt structure',
  },
  {
    file: 'daemons/semantic-search/embed-vault.js',
    accessor: 'frontmatterList',
    needle: "frontmatterList(content, 'tags')",
    reason: 'tags remain single-line embedding metadata rather than prompt structure',
  },
];

// This is the implementation of the reason-gated file accessor itself, not a
// bypassing consumer.
const JS_DIRECT_READ_ALLOWLIST = [
  {
    file: 'daemons/lifecycle-common.mjs',
    rule: 'direct-capsule-read',
    needle: "return readFileSync(capsulePath, 'utf8');",
    reason: 'unsafeRawCapsuleDocument validates the reason before this byte read',
  },
];

// The Python compactor must preserve existing bodies during metadata relinking,
// then inspect two specific multiline sections one bullet at a time.
const PYTHON_RAW_ALLOWLIST = [
  {
    file: 'daemons/capsule-compact.py',
    accessor: 'unsafeRawCapsuleParts',
    reason: 'capsule compaction preserves the complete body while relinking metadata',
  },
  {
    file: 'daemons/capsule-compact.py',
    accessor: 'unsafeRawBodySection',
    reason: 'compaction selects individual open-thread bullets from a multiline body section',
  },
  {
    file: 'daemons/capsule-compact.py',
    accessor: 'unsafeRawBodySection',
    reason: 'compaction selects individual held-decision bullets from a multiline body section',
  },
];

// Shell cannot import the JavaScript reader. These exact embedded-Python
// parsers are narrow: routing metadata is normalized before indexing; the
// system check validates complete capsules, then renders raw filenames and
// schema details through ck/inert; the installer/doctor predicates only decide
// whether trusted agent definitions are eligible for explicit raw promotion.
const SHELL_PARSER_ALLOWLIST = [
  {
    file: 'daemons/caddy-reindex.sh',
    rule: 'frontmatter-parser-declaration',
    needle: 'def read_single_line_frontmatter(text):',
    reason: 'routing metadata scalars are collapsed before entering the model-facing index',
  },
  {
    file: 'daemons/caddy-reindex.sh',
    rule: 'frontmatter-delimiter-parser',
    needle: 'm = re.match(r"^---\\s*\\n(.*?)\\n---\\s*\\n", text, re.DOTALL)',
    reason: 'the build-time routing parser returns only normalized scalar metadata',
  },
  {
    file: 'daemons/system-check.sh',
    rule: 'frontmatter-delimiter-parser',
    needle: 'match = re.match(r"^\\ufeff?---\\r?\\n(.*?)\\r?\\n---", text, re.DOTALL)',
    reason: 'read-only schema validation returns raw filenames and details that ck renders through inert',
  },
  {
    file: 'install.sh',
    rule: 'frontmatter-key-sniff',
    needle: "head -20 \"$agent_file\" | grep -q '^name:' && head -20 \"$agent_file\" | grep -q '^tools:'",
    reason: 'registration predicate precedes explicit reason-gated agent definition promotion',
  },
  {
    file: 'scripts/doctor.sh',
    rule: 'frontmatter-key-sniff',
    needle: "head -20 \"$agent_file\" | grep -q '^name:' && head -20 \"$agent_file\" | grep -q '^tools:'",
    reason: 'doctor fix predicate precedes explicit reason-gated agent definition promotion',
  },
];

// Tree-copy helpers can promote procedure-bearing directories even when their
// paths are indirect variables. Every definition and production invocation is
// therefore named exactly, including non-procedure asset deployment copies.
const SHELL_COPY_ALLOWLIST = [
  {
    file: 'install.sh',
    rule: 'copy-tree-definition',
    needle: 'copy_missing_tree() {',
    reason: 'the installer defines one no-clobber tree copier whose every invocation is audited below',
  },
  {
    file: 'install.sh',
    rule: 'copy-tree-call',
    needle: 'copy_missing_tree "$source" "$destination" 1',
    reason: 'the reason-gated procedure promotion wrapper delegates to the audited no-clobber copier',
  },
  {
    file: 'install.sh',
    rule: 'copy-tree-call',
    needle: 'hooks|daemons) copy_missing_tree "$SRC/$dir" "$TARGET/$dir" 1 ;;',
    reason: 'installer code and hook trees are copied as reviewed framework implementation files',
  },
  {
    file: 'install.sh',
    rule: 'copy-tree-call',
    needle: '*)             copy_missing_tree "$SRC/$dir" "$TARGET/$dir" 0 ;;',
    reason: 'remaining enumerated framework trees use the audited no-clobber installation helper',
  },
  {
    file: 'launcher/install.sh',
    rule: 'recursive-copy',
    needle: 'cp -r "$source" "$destination"',
    reason: 'the launcher reason-gated skill installer copies one reviewed procedure tree',
  },
  {
    file: 'skills/frontend-slides/scripts/deploy.sh',
    rule: 'recursive-copy',
    needle: 'cp -r "$SOURCE_FILE" "$TARGET_DIR/"',
    reason: 'the slide deploy utility copies operator-selected static page assets, not runtime procedures',
  },
  {
    file: 'skills/frontend-slides/scripts/deploy.sh',
    rule: 'recursive-copy',
    needle: 'cp -r "$PARENT_DIR/assets" "$DEPLOY_DIR/assets" 2>/dev/null || true',
    reason: 'the slide deploy utility copies its operator-selected static asset directory',
  },
];

// Shell has no module import boundary, so intentional multiline promotion is
// wrapped in reason-gated unsafeRaw* functions. Every production invocation is
// consumed exactly once here.
const SHELL_RAW_ALLOWLIST = [
  {
    file: 'daemons/codex-adapter.sh',
    accessor: 'unsafeRawOperatorTask',
    reason: 'the operator-supplied task is intentionally the complete multiline Codex prompt',
  },
  // Session summaries inspect the multiline daily capture section, but every
  // extracted value is collapsed, quoted, and bounded before rendering.
  {
    file: 'hooks/session-capture-summary.sh',
    accessor: 'unsafeRawSessionCaptureSummary',
    reason: 'the summary reads a multiline daily capture section before rendering each field through a quoted bound',
  },
  {
    file: 'daemons/system-check.sh',
    accessor: 'unsafeRawValidateCapsules',
    reason: 'system-check validates complete capsule documents before rendering only inert schema results',
  },
  {
    file: 'daemons/system-check.sh',
    accessor: 'unsafeRawRecentDaemonErrors',
    reason: 'system-check preserves recent multiline diagnostics until ck renders them as one inert value',
  },
  // The standalone harness installer promotes reviewed SKILL.md procedure
  // trees into the runtime directory that Claude resolves.
  {
    file: 'launcher/install.sh',
    accessor: 'unsafeRawInstallSkillTree',
    reason: "launcher installation promotes reviewed multiline skill procedures into Claude's runtime",
  },
  {
    file: 'install.sh',
    accessor: 'unsafeRawProcedureFile',
    reason: 'the framework CLAUDE.md is operator-reviewed multiline procedure text installed verbatim',
  },
  {
    file: 'install.sh',
    accessor: 'unsafeRawInstallProcedureFile',
    reason: 'the marker-wrapped framework procedure is intentionally installed with its authored structure',
  },
  {
    file: 'install.sh',
    accessor: 'unsafeRawProcedureFile',
    reason: 'installer refresh preserves operator-authored multiline text outside managed markers',
  },
  {
    file: 'install.sh',
    accessor: 'unsafeRawProcedureFile',
    reason: 'installer refresh appends the reviewed marker-wrapped framework procedure verbatim',
  },
  {
    file: 'install.sh',
    accessor: 'unsafeRawPromoteProcedureFile',
    reason: "the post-compact rule is reviewed multiline procedure text promoted into Claude's runtime",
  },
  {
    file: 'install.sh',
    accessor: 'unsafeRawPromoteProcedureTree',
    reason: 'system documents are reviewed multiline procedures loaded by the operating prompt',
  },
  {
    file: 'install.sh',
    accessor: 'unsafeRawPromoteProcedureTree',
    reason: 'top-level skill trees are reviewed multiline procedures copied into the installed framework',
  },
  {
    file: 'install.sh',
    accessor: 'unsafeRawPromoteProcedureTree',
    reason: "skill directories contain reviewed multiline procedures promoted into Claude's runtime",
  },
  {
    file: 'install.sh',
    accessor: 'unsafeRawInstallAgentDefinition',
    reason: "agent definitions are operator-authored multiline procedure text promoted into Claude's runtime directory",
  },
  {
    file: 'scripts/doctor.sh',
    accessor: 'unsafeRawRepairAgentDefinition',
    reason: "doctor --fix promotes operator-authored multiline agent procedure text into Claude's runtime directory",
  },
];

function consumeExactAllowance(allowlist, seen, file, rule, snippet) {
  const index = allowlist.findIndex(
    (entry) => entry.file === file && entry.rule === rule && snippet.includes(entry.needle),
  );
  if (index < 0) return false;
  seen.set(index, (seen.get(index) || 0) + 1);
  return true;
}

function consumeExactLineAllowance(allowlist, seen, file, rule, snippet) {
  const index = allowlist.findIndex(
    (entry) => entry.file === file && entry.rule === rule && snippet === entry.needle,
  );
  if (index < 0) return false;
  seen.set(index, (seen.get(index) || 0) + 1);
  return true;
}

function scanJavaScript(file, source, rawSeen, readSeen, safeSeen) {
  // Deliberate whole-file exemption: this is the canonical JavaScript reader.
  // Its parser and raw-reader behavior is defended by render-boundary.test.mjs;
  // the same source shapes remain prohibited everywhere else.
  if (file === CANONICAL_JS_READER) return [];
  const failures = [];
  const rules = [
    [
      'local-frontmatter-parser',
      /\b(?:function\s+|(?:const|let|var)\s+)(?:(?:parse|read|strip|extract)[A-Za-z0-9_]*(?:[Ff]rontmatter|[Yy]aml)[A-Za-z0-9_]*|frontmatter(?:Scalar|Field|Value|Of))\b/g,
    ],
    [
      'frontmatter-delimiter-parser',
      /\.(?:match|exec|split|search|indexOf|startsWith)\(\s*(?:\/|['"`])[^)\n]{0,240}---/g,
    ],
    [
      'frontmatter-delimiter-regex',
      /\/\^(?:\\uFEFF|﻿)?---[^/\n]{0,240}\//g,
    ],
    ['dynamic-scalar-parser', /new RegExp\(\s*`?\^\$\{[^}]+\}:[^)]{0,160}\)/g],
    [
      'line-scalar-parser',
      /\.split\(\s*(?:['"]\\n['"]|\/(?:\\r\?\\n|\\n|\\r\\n\|\\n)\/)\s*\)[\s\S]{0,400}?\.startsWith\(\s*(?:`?\$\{[^}]+\}:|[A-Za-z_$][\w$]*\s*\+\s*['"]:)/g,
    ],
    [
      'line-scalar-parser',
      /\.split\(\s*(?:['"]\\n['"]|\/(?:\\r\?\\n|\\n|\\r\\n\|\\n)\/)\s*\)[\s\S]{0,500}?\.indexOf\(\s*(?:`?\$\{[^}]+\}:|[A-Za-z_$][\w$]*\s*\+\s*['"]:)['"]?\s*\)\s*={2,3}\s*0/g,
    ],
    [
      'capsule-key-parser',
      /\.(?:match|search|exec)\(\s*\/[^/\n]{0,200}(?:objective|waiting_on|next_valid_action|created_at|parent_capsule_id)\s*:/g,
    ],
    ['yaml-parser-library', /\b(?:gray-matter|front-matter|js-yaml|from ['"]yaml['"]|require\(['"]yaml['"]\))/g],
  ];
  for (const [rule, expression] of rules) {
    for (const match of matches(source, expression)) {
      failures.push(violation(file, source, match.index, rule));
    }
  }
  for (const match of readFileAliases(source).findings) {
    failures.push(violation(file, source, match.index, 'read-file-alias'));
  }
  for (const match of rawReadInterpolations(source)) {
    failures.push(violation(file, source, match.index, 'raw-read-interpolation'));
  }
  for (const match of jsonReadInterpolations(source)) {
    failures.push(violation(file, source, match.index, 'json-read-interpolation'));
  }
  for (const match of expressionDelimiterParsers(source)) {
    failures.push(violation(
      file,
      source,
      match.index,
      'frontmatter-delimiter-expression',
    ));
  }
  for (const match of childProcessInterpolations(source)) {
    failures.push(violation(file, source, match.index, 'child-process-interpolation'));
  }
  for (const match of environmentInterpolations(source)) {
    failures.push(violation(file, source, match.index, 'environment-interpolation'));
  }

  const directReads = /\b(?:readFileSync|readFile)\s*\(\s*(?:newest\.path|cap\.path|[A-Za-z0-9_.$]*capsule[A-Za-z0-9_.$]*|[^,\n)]*capsules[^,\n)]*)/gi;
  for (const match of matches(source, directReads)) {
    const snippet = lineSnippet(source, match.index);
    if (!consumeExactAllowance(
      JS_DIRECT_READ_ALLOWLIST,
      readSeen,
      file,
      'direct-capsule-read',
      snippet,
    )) {
      failures.push(violation(file, source, match.index, 'direct-capsule-read'));
    }
  }

  for (const match of unsafeJavaScriptIndirections(source)) {
    failures.push(violation(file, source, match.index, 'unsafe-raw-indirection'));
  }
  for (const match of unsafeTokenViolations(source)) {
    failures.push(violation(file, source, match.index, 'unsafe-raw-token-use'));
  }
  for (const match of safeReaderIndirections(source)) {
    failures.push(violation(file, source, match.index, 'shared-reader-indirection'));
  }
  for (const call of findSafeReaderCalls(source)) {
    const allowance = JS_SAFE_READER_ALLOWLIST.findIndex(
      (entry) => entry.file === file
        && entry.accessor === call.accessor
        && call.text.includes(entry.needle),
    );
    if (allowance < 0) {
      failures.push(violation(file, source, call.index, 'unaudited-shared-reader-call'));
    } else {
      safeSeen.set(allowance, (safeSeen.get(allowance) || 0) + 1);
    }
  }
  for (const call of findUnsafeCalls(source)) {
    const allowance = JS_RAW_ALLOWLIST.findIndex(
      (entry) => entry.file === file
        && entry.accessor === call.accessor
        && literalReason(call.text) === entry.reason,
    );
    if (allowance < 0) {
      failures.push(violation(file, source, call.index, 'unaudited-unsafe-raw-call'));
    } else {
      rawSeen.set(allowance, (rawSeen.get(allowance) || 0) + 1);
    }
  }
  return failures;
}

function parserFindings(file, source) {
  const findings = [];
  const patterns = [
    [
      'frontmatter-parser-declaration',
      /\bdef\s+(?:parse|read|strip|extract)[A-Za-z0-9_]*(?:frontmatter|yaml)[A-Za-z0-9_]*\s*\(/gi,
    ],
    [
      'frontmatter-parser-declaration',
      /\b(?:function\s+|(?:const|let|var)\s+)(?:(?:parse|read|strip|extract)[A-Za-z0-9_]*(?:frontmatter|yaml)[A-Za-z0-9_]*|frontmatter(?:Scalar|Field|Value|Of))\b/gi,
    ],
    [
      'frontmatter-delimiter-parser',
      /\bre\.(?:compile|match|search)\s*\([\s\S]{0,320}?---/gi,
    ],
    [
      'frontmatter-delimiter-parser',
      /\.(?:match|exec|split|search|indexOf|partition|find)\(\s*(?:\/|['"`])[^)\n]{0,240}---/gi,
    ],
    [
      'frontmatter-shell-expansion',
      /\$\{[A-Za-z_][A-Za-z0-9_]*(?:#{1,2}|%{1,2})[^}\r\n]{0,200}---[^}\r\n]*\}/g,
    ],
    [
      'frontmatter-shell-field-loop',
      /\bwhile[ \t]+IFS[ \t]*=[ \t]*['"]?:['"]?[ \t]+read(?:[ \t]+-[A-Za-z]+)*\b/gi,
    ],
    [
      'capsule-key-parser',
      /\bre\.(?:compile|match|search)\s*\([\s\S]{0,320}?(?:objective|waiting_on|next_valid_action|created_at|parent_capsule_id)\s*:/gi,
    ],
    [
      'frontmatter-key-sniff',
      /\bhead\s+(?:-[0-9]+|-n[ \t]+[0-9]+)[^#\n]*\|\s*grep[^#\n]*'\^(?:name|tools):'/gi,
    ],
    [
      'frontmatter-key-shell-parser',
      /\b(?:awk|sed)\b[^#\n]{0,260}(?:objective|waiting_on|next_valid_action|created_at|parent_capsule_id|name|tools):/gi,
    ],
    [
      'capsule-key-line-parser',
      /\.(?:partition|startswith)\(\s*['"](?:objective|waiting_on|next_valid_action|created_at|parent_capsule_id):/gi,
    ],
    ['yaml-parser-library', /\b(?:yaml\.safe_load|from yaml|import yaml|python-frontmatter)\b/gi],
  ];
  for (const [rule, expression] of patterns) {
    for (const match of matches(source, expression)) {
      findings.push({ rule, index: match.index });
    }
  }
  return findings;
}

function shellCodeOnlyLine(line) {
  let quote = null;
  let escaped = false;
  let masked = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== null) {
      masked += ' ';
      if (escaped) escaped = false;
      else if (char === '\\' && quote === '"') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      masked += ' ';
    } else if (char === '#') {
      masked += ' '.repeat(line.length - index);
      break;
    } else {
      masked += char;
    }
  }
  return masked.padEnd(line.length, ' ');
}

function shellTreeCopies(source) {
  const findings = [];
  const lines = source.split(/\r?\n/);
  let offset = 0;
  for (const line of lines) {
    const masked = shellCodeOnlyLine(line);
    for (const match of matches(masked, /\bcopy_missing_tree\b/g)) {
      const after = masked.slice(match.index + match[0].length);
      findings.push({
        rule: /^[ \t]*\(\)[ \t]*\{/.test(after)
          ? 'copy-tree-definition'
          : 'copy-tree-call',
        index: offset + match.index,
      });
    }
    for (const match of matches(
      masked,
      /\bcp\b(?=[ \t])(?=[^;&|]{0,200}(?:--(?:recursive|archive)\b|-[A-Za-z]*[rRa][A-Za-z]*\b))/g,
    )) {
      findings.push({ rule: 'recursive-copy', index: offset + match.index });
    }
    offset += line.length + 1;
  }
  return findings;
}

function findShellUnsafeCalls(source) {
  const calls = [];
  const lines = source.split(/\r?\n/);
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  for (let index = 0; index < lines.length; index += 1) {
    const masked = shellCodeOnlyLine(lines[index]);
    for (const match of matches(masked, /\b(unsafeRaw[A-Za-z0-9_]*)\b/g)) {
      const after = masked.slice(match.index + match[1].length);
      if (/^[ \t]*\(\)[ \t]*\{/.test(after)) continue;
      const callLines = [lines[index]];
      let cursor = index;
      while (callLines.at(-1).trimEnd().endsWith('\\') && cursor + 1 < lines.length) {
        cursor += 1;
        callLines.push(lines[cursor]);
      }
      calls.push({
        accessor: match[1],
        index: offsets[index] + match.index,
        text: callLines.join('\n'),
      });
    }
  }
  return calls;
}

function shellHasLiteralReason(callText, reason) {
  const argumentsFound = callText.split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().replace(/\\[ \t]*$/, '').trim())
    .filter((line) => line && !line.startsWith('||') && !line.startsWith('&&'));
  const finalArgument = argumentsFound.at(-1);
  return finalArgument === `"${reason}"` || finalArgument === `'${reason}'`;
}

function scanShell(file, source, parserSeen, rawSeen, copySeen = new Map()) {
  const failures = [];
  for (const finding of parserFindings(file, source)) {
    const snippet = lineSnippet(source, finding.index);
    if (!consumeExactAllowance(
      SHELL_PARSER_ALLOWLIST,
      parserSeen,
      file,
      finding.rule,
      snippet,
    )) {
      failures.push(violation(file, source, finding.index, finding.rule));
    }
  }
  for (const finding of shellTreeCopies(source)) {
    const snippet = lineSnippet(source, finding.index);
    if (!consumeExactLineAllowance(
      SHELL_COPY_ALLOWLIST,
      copySeen,
      file,
      finding.rule,
      snippet,
    )) {
      failures.push(violation(file, source, finding.index, 'unaudited-tree-copy'));
    }
  }
  for (const match of shellReadInterpolations(source)) {
    failures.push(violation(file, source, match.index, 'shell-read-interpolation'));
  }
  for (const definition of matches(
    source,
    /^[ \t]*(unsafeRaw[A-Za-z0-9_]*)\(\)[ \t]*\{[\s\S]{0,500}?^[ \t]*\}/gm,
  )) {
    if (!/\b(?:local[^\n]*\breason=|reason="\$[0-9]+")/.test(definition[0])
      || !/(?:\[\[?)[^\n]*-n[ \t]+"\$reason"/.test(definition[0])) {
      failures.push(violation(file, source, definition.index, 'unsafe-raw-missing-reason-guard'));
    }
  }
  for (const match of matches(
    source,
    /(?:\$\(|\bif[ \t]+|&&[ \t]*|\|\|[ \t]*)(unsafeRaw[A-Za-z0-9_]*)\b/g,
  )) {
    failures.push(violation(file, source, match.index, 'unsafe-raw-indirect-shell-call'));
  }
  for (const call of findShellUnsafeCalls(source)) {
    const allowance = SHELL_RAW_ALLOWLIST.findIndex(
      (entry) => entry.file === file
        && entry.accessor === call.accessor
        && shellHasLiteralReason(call.text, entry.reason),
    );
    if (allowance < 0) {
      failures.push(violation(file, source, call.index, 'unaudited-unsafe-raw-call'));
    } else {
      rawSeen.set(allowance, (rawSeen.get(allowance) || 0) + 1);
    }
  }
  return failures;
}

function scanPython(file, source, rawSeen) {
  // Deliberate whole-file exemption: this is the canonical Python reader.
  // Its exports and reader behavior are defended by tests/test_runtime_paths.py;
  // the same source shapes remain prohibited everywhere else.
  if (file === CANONICAL_PYTHON_READER) return [];
  const failures = parserFindings(file, source)
    .map((finding) => violation(file, source, finding.index, finding.rule));
  for (const match of pythonReadInterpolations(source)) {
    failures.push(violation(file, source, match.index, 'python-read-interpolation'));
  }
  for (const match of pythonVariableDelimiterParsers(source)) {
    failures.push(violation(
      file,
      source,
      match.index,
      'frontmatter-delimiter-variable',
    ));
  }
  for (const match of matches(
    source,
    /\bimport[ \t]+(?:daemons\.)?render_boundary\b/g,
  )) {
    failures.push(violation(file, source, match.index, 'reader-module-import'));
  }
  for (const match of matches(
    source,
    /\bfrom[ \t]+(?:daemons\.|\.)?render_boundary[ \t]+import[ \t]+(\([\s\S]*?\)|[^\r\n]+)/g,
  )) {
    const imported = match[1]
      .replace(/^\(|\)$/g, '')
      .replace(/#[^\r\n]*/g, '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    for (const name of imported) {
      if (name.includes(' as ') || !PYTHON_PUBLIC_READERS.has(name)) {
        failures.push(violation(file, source, match.index, 'private-reader-helper-access'));
      }
    }
  }
  for (const match of matches(
    source,
    /\b[A-Za-z_][A-Za-z0-9_]*\._(?:FRONTMATTER|LINE_BREAKING|frontmatter|raw_scalar_token|decode_scalar)\b/g,
  )) {
    failures.push(violation(file, source, match.index, 'private-reader-helper-access'));
  }
  for (const match of unsafePythonIndirections(source)) {
    failures.push(violation(file, source, match.index, 'unsafe-raw-indirection'));
  }
  for (const call of findUnsafeCalls(source)) {
    const allowance = PYTHON_RAW_ALLOWLIST.findIndex(
      (entry) => entry.file === file
        && entry.accessor === call.accessor
        && literalReason(call.text) === entry.reason,
    );
    if (allowance < 0) {
      failures.push(violation(file, source, call.index, 'unaudited-unsafe-raw-call'));
    } else {
      rawSeen.set(allowance, (rawSeen.get(allowance) || 0) + 1);
    }
  }
  return failures;
}

function staleAllowances(allowlist, seen, family) {
  const failures = [];
  for (let index = 0; index < allowlist.length; index += 1) {
    const entry = allowlist[index];
    assert.ok(entry.reason.length >= 20, `${family} allowance needs a substantive reason: ${entry.file}`);
    const count = seen.get(index) || 0;
    if (count !== 1) {
      failures.push(
        `${entry.file}:0 [${family}-allowance-count] expected=1 actual=${count} accessor_or_rule=${JSON.stringify(entry.accessor || entry.rule)}`,
      );
    }
  }
  return failures;
}

const populations = {
  javascript: productionJavaScript(),
  shell: productionByExtension('.sh'),
  python: productionByExtension('.py'),
};

test('production scan populations are non-empty, broad, and carry sentinels', () => {
  for (const [language, files] of Object.entries(populations)) {
    assert.ok(files.length > 0, `${language} production scan matched zero files`);
    assert.ok(
      files.length >= MINIMUM_COUNTS[language],
      `${language} production scan shrank below reviewed minimum: ${files.length} < ${MINIMUM_COUNTS[language]}`,
    );
    for (const file of files) assert.ok(statSync(file).isFile());
  }
  const all = new Set(Object.values(populations).flat().map(relative));
  for (const sentinel of [
    'daemons/lifecycle-common.mjs',
    'daemons/frontmatter-reader.cjs',
    'daemons/raw-acquisitions.mjs',
    'hooks/tool-tracker.js',
    'tools/capture-arch.mjs',
    'install.sh',
    'daemons/caddy-reindex.sh',
    'daemons/system-check.sh',
    'daemons/capsule-compact.py',
    'daemons/render_boundary.py',
    'daemons/runtime/update-active-state.py',
  ]) {
    assert.ok(all.has(sentinel), `production scan missed sentinel ${sentinel}`);
  }
});

test('production readers and raw access stay centralized or exactly audited', () => {
  const failures = [];
  const jsRawSeen = new Map();
  const jsSafeSeen = new Map();
  const directReadSeen = new Map();
  const shellParserSeen = new Map();
  const shellRawSeen = new Map();
  const shellCopySeen = new Map();
  const pythonRawSeen = new Map();

  for (const absolute of populations.javascript) {
    const file = relative(absolute);
    failures.push(...scanJavaScript(
      file,
      readFileSync(absolute, 'utf8'),
      jsRawSeen,
      directReadSeen,
      jsSafeSeen,
    ));
  }
  for (const absolute of populations.shell) {
    const file = relative(absolute);
    failures.push(...scanShell(
      file,
      readFileSync(absolute, 'utf8'),
      shellParserSeen,
      shellRawSeen,
      shellCopySeen,
    ));
  }
  for (const absolute of populations.python) {
    const file = relative(absolute);
    failures.push(...scanPython(file, readFileSync(absolute, 'utf8'), pythonRawSeen));
  }

  failures.push(...staleAllowances(JS_RAW_ALLOWLIST, jsRawSeen, 'js-raw'));
  failures.push(...staleAllowances(JS_SAFE_READER_ALLOWLIST, jsSafeSeen, 'js-safe-reader'));
  failures.push(...staleAllowances(JS_DIRECT_READ_ALLOWLIST, directReadSeen, 'js-direct-read'));
  failures.push(...staleAllowances(SHELL_PARSER_ALLOWLIST, shellParserSeen, 'shell-parser'));
  failures.push(...staleAllowances(SHELL_RAW_ALLOWLIST, shellRawSeen, 'shell-raw'));
  failures.push(...staleAllowances(SHELL_COPY_ALLOWLIST, shellCopySeen, 'shell-copy'));
  failures.push(...staleAllowances(PYTHON_RAW_ALLOWLIST, pythonRawSeen, 'python-raw'));

  assert.deepEqual(failures, [], failures.join('\n'));
});

test('probe E1 rejects JSON-decoded file fields in JavaScript renders', () => {
  const rules = scanJavaScript(
    'mutation/e1-json-read.mjs',
    probeSource('e1-json-read.mjs'),
    new Map(),
    new Map(),
    new Map(),
  ).join('\n');
  assert.equal(
    (rules.match(/\[json-read-interpolation\]/g) || []).length,
    4,
    rules,
  );
});

test('probe E2 rejects expression-built delimiters in JavaScript scalar readers', () => {
  const rules = scanJavaScript(
    'mutation/e2-delimiter-expression.mjs',
    probeSource('e2-delimiter-expression.mjs'),
    new Map(),
    new Map(),
    new Map(),
  ).join('\n');
  assert.match(rules, /\[frontmatter-delimiter-expression\]/);
});

test('probe E3 rejects child-process output in JavaScript renders', () => {
  const rules = scanJavaScript(
    'mutation/e3-child-process.mjs',
    probeSource('e3-child-process.mjs'),
    new Map(),
    new Map(),
    new Map(),
  ).join('\n');
  assert.equal(
    (rules.match(/\[child-process-interpolation\]/g) || []).length,
    5,
    rules,
  );
});

test('probe E4 rejects environment values in JavaScript renders', () => {
  const rules = scanJavaScript(
    'mutation/e4-environment.mjs',
    probeSource('e4-environment.mjs'),
    new Map(),
    new Map(),
    new Map(),
  ).join('\n');
  assert.equal(
    (rules.match(/\[environment-interpolation\]/g) || []).length,
    5,
    rules,
  );
});

test('probe unsafeRaw non-call uses reject aliases and escapes', () => {
  const rules = scanJavaScript(
    'mutation/unsafe-raw-non-call.mjs',
    probeSource('unsafe-raw-non-call.mjs'),
    new Map(),
    new Map(),
    new Map(),
  ).join('\n');
  assert.equal(
    (rules.match(/\[unsafe-raw-indirection\]/g) || []).length,
    6,
    rules,
  );
});

test('probe P1 rejects Python file reads in renders', () => {
  const rules = scanPython(
    'mutation/p1-python-read.py',
    probeSource('p1-python-read.py'),
    new Map(),
  ).join('\n');
  assert.equal(
    (rules.match(/\[python-read-interpolation\]/g) || []).length,
    9,
    rules,
  );
});

test('probe P2 rejects shell file reads in renders', () => {
  const rules = scanShell(
    'mutation/p2-shell-read.sh',
    probeSource('p2-shell-read.sh'),
    new Map(),
    new Map(),
    new Map(),
  ).join('\n');
  assert.equal(
    (rules.match(/\[shell-read-interpolation\]/g) || []).length,
    6,
    rules,
  );
});

test('probe P3 rejects variable delimiters in Python scalar readers', () => {
  const rules = scanPython(
    'mutation/p3-python-delimiter.py',
    probeSource('p3-python-delimiter.py'),
    new Map(),
  ).join('\n');
  assert.equal(
    (rules.match(/\[frontmatter-delimiter-variable\]/g) || []).length,
    4,
    rules,
  );
});

test('probe delimiter rules ignore comments, strings, and unrelated Python scopes', () => {
  const jsRules = scanJavaScript(
    'mutation/e2-lookalikes.mjs',
    `const example = "const DELIMITER = '-'.repeat(3)";\n`
      + `// const COMMENT_DELIMITER = '-'.repeat(3);\n`
      + `const sliced = row.slice(0, DELIMITER.length) === DELIMITER;\n`,
    new Map(),
    new Map(),
    new Map(),
  ).join('\n');
  assert.doesNotMatch(jsRules, /\[frontmatter-delimiter-expression\]/);

  const pythonRules = scanPython(
    'mutation/p3-lookalikes.py',
    `def docs():\n`
      + `    text = """\nDELIMITER = "---"\n"""\n`
      + `    DELIMITER = "---"\n`
      + `    return text\n\n`
      + `def csv_value(text, DELIMITER):\n`
      + `    return text.split(DELIMITER, 2)[0]\n`,
    new Map(),
  ).join('\n');
  assert.doesNotMatch(pythonRules, /\[frontmatter-delimiter-variable\]/);
});

test('probe shell render rule ignores comments, printf variables, and real pipelines', () => {
  const rules = scanShell(
    'mutation/p2-non-sinks.sh',
    `NOTE="$(cat "$STATE_FILE")"\n`
      + `# printf '%s' "$NOTE"\n`
      + `printf -v OUTPUT '%s' "$NOTE"\n`
      + `printf '%s' "$NOTE" | consume_safely\n`
      + `printf '%s' "$NOTE" \\\n`
      + `  | consume_safely\n`
      + `# echo "$(cat "$STATE_FILE")"\n`
      + `echo '$(cat "$STATE_FILE")'\n`
      + `echo "\\$(cat "$STATE_FILE")"\n`
      + `printf -v INLINE '%s' "$(cat "$STATE_FILE")"\n`
      + `echo "$(cat "$STATE_FILE")" | consume_safely\n`
      + `echo "$(cat)"\n`
      + `kind=printf DATA="$(cat f)"\n`,
    new Map(),
    new Map(),
    new Map(),
  ).join('\n');
  assert.doesNotMatch(rules, /\[shell-read-interpolation\]/);
});

test('mutation samples are caught by the same structural rules', () => {
  const jsMutation = `
    import { readFileSync } from 'node:fs';
    import { readFile as renamedRead } from 'node:fs/promises';
    function frontmatterScalar(doc, key) {
      const fm = doc.match(/^---\\n([\\s\\S]*?)\\n---/);
      return fm[1].match(new RegExp(\`^\${key}: (.*)$\`, 'm'))?.[1];
    }
    const doc = readFileSync(capsulePath, 'utf8');
    const prompt = \`objective: \${frontmatterScalar(doc, 'objective')}\`;
    const sharedPrompt = \`objective: \${scalar(doc, 'objective')}\`;
    unsafeRawBodySection(doc, 'objective', 'not audited');
    const rawAlias = unsafeRawScalar;
    const field = (text, key) => text.split(/\\r?\\n/).find((line) => line.startsWith(\`\${key}:\`));
    const blob = readFileSync(file, 'utf8');
    const renamedPrompt = \`objective: \${field(blob, 'objective')}\`;
    const lineField = (text, key) => text.split(/\\r?\\n/).find((line) => line.startsWith(key + ':'));
    const derived = lineField(doc, 'objective');
    const intermediatePrompt = \`objective: \${derived}\`;
    const incompleteBoundary = collapseLineBreaking(doc);
    const incompletePrompt = \`objective: \${incompleteBoundary}\`;
    const rawMemberAlias = reader.unsafeRawScalar;
    const safeMemberAlias = reader.scalar;
    (unsafeRawScalar)(doc, 'objective', 'not audited');
    unsafeRawScalar?.(doc, 'objective', 'not audited');
    (scalar)(doc, 'objective');
    scalar?.(doc, 'objective');
    scalar.call(reader, doc, 'objective');
    reader.scalar.apply(reader, [doc, 'objective']);
    reader?.scalar(doc, 'objective');
    reader.scalar?.(doc, 'objective');
    reader['scalar'](doc, 'objective');
    reader?.['capsuleValue']?.(doc, 'objective');
    reader['bodySection'].bind(reader)(doc, 'Pending Gates');
    Reflect.get(reader, 'unsafeRawScalar')(doc, 'objective', 'not audited');
    Object.getOwnPropertyDescriptor(reader, 'unsafeRawBodySection').value(
      doc, 'objective', 'not audited',
    );
    registry.set('raw-reader', unsafeRawScalar);
    const promisedBlob = await fs.promises.readFile(file, 'utf8');
    const promisedPrompt = \`objective: \${promisedBlob}\`;
    const memberBlob = await fsp.readFile(memberFile, 'utf8');
    promptParts.push(memberBlob);
    const slurp = io.deep.readFileSync;
    const aliasedBlob = slurp(aliasFile, 'utf8');
    const aliasedPrompt = 'objective: ' + aliasedBlob;
    const importedBlob = await renamedRead(importedFile, 'utf8');
    promptParts.push(importedBlob);
    const bracketBlob = await fsp['readFile'](bracketFile, 'utf8');
    promptParts.push(bracketBlob);
    const reflectedRead = Reflect.get(fsp, 'readFile');
    process.stdout.write(await reflectedRead(reflectedFile, 'utf8'));
    const inlineTemplate = \`objective: \${await fsp.readFile(templateFile, 'utf8')}\`;
    const inlineConcat = 'objective: ' + io.deep.readFileSync(concatSource, 'utf8');
    process.stdout.write(await fsp.readFile(streamSource, 'utf8'));
    writeSync(1, io.fs.readFileSync(fdInlineSource, 'utf8'));
    const concatenatedBlob = readFileSync(concatFile, 'utf8');
    const concatenatedPrompt = 'objective: ' + concatenatedBlob;
    const pushedBlob = readFileSync(pushFile, 'utf8');
    promptParts.push(pushedBlob);
    const streamedBlob = readFileSync(streamFile, 'utf8');
    process.stdout.write(streamedBlob);
    const persistedBlob = readFileSync(persistFile, 'utf8');
    writeFileSync(destination, persistedBlob);
    const fileDescriptorBlob = readFileSync(fdSource, 'utf8');
    writeSync(1, fileDescriptorBlob);
    const neutralValue = (text, key) => text.split('\\n')
      .find((row) => row.indexOf(key + ':') === 0)
      ?.split(':').slice(1).join(':');
    const asyncDoc = await fs.promises.readFile(source, 'utf8');
    const asyncPrompt = \`objective: \${neutralValue(asyncDoc, 'objective')}\`;
  `;
  const jsRules = scanJavaScript(
    'mutation/new-render.mjs',
    jsMutation,
    new Map(),
    new Map(),
    new Map(),
  )
    .join('\n');
  assert.match(jsRules, /local-frontmatter-parser/);
  assert.match(jsRules, /frontmatter-delimiter-parser/);
  assert.match(jsRules, /dynamic-scalar-parser/);
  assert.match(jsRules, /direct-capsule-read/);
  assert.match(jsRules, /unaudited-unsafe-raw-call/);
  assert.match(jsRules, /unsafe-raw-indirection/);
  assert.match(jsRules, /unsafe-raw-token-use/);
  assert.match(jsRules, /unaudited-shared-reader-call/);
  assert.match(jsRules, /raw-read-interpolation/);
  assert.match(jsRules, /line-scalar-parser/);
  assert.match(jsRules, /collapseLineBreaking/);
  assert.match(jsRules, /rawMemberAlias/);
  assert.match(jsRules, /safeMemberAlias/);
  assert.match(jsRules, /scalar\.call/);
  assert.match(jsRules, /scalar\.apply/);
  assert.match(jsRules, /reader\?\.scalar/);
  assert.match(jsRules, /scalar\?\.\(/);
  assert.match(jsRules, /reader\['scalar'\]/);
  assert.match(jsRules, /reader\?\.\['capsuleValue'\]/);
  assert.match(jsRules, /bodySection'\]\.bind/);
  assert.match(jsRules, /Reflect\.get/);
  assert.match(jsRules, /Object\.getOwnPropertyDescriptor/);
  assert.match(jsRules, /registry\.set\('raw-reader', unsafeRawScalar/);
  assert.match(jsRules, /fsp\.readFile\(memberFile/);
  assert.match(jsRules, /const slurp = io\.deep\.readFileSync/);
  assert.match(jsRules, /slurp\(aliasFile/);
  assert.match(jsRules, /readFile as renamedRead/);
  assert.match(jsRules, /renamedRead\(importedFile/);
  assert.match(jsRules, /fsp\['readFile'\]\(bracketFile/);
  assert.match(jsRules, /Reflect\.get\(fsp, 'readFile'\)/);
  assert.match(jsRules, /fsp\.readFile\(templateFile/);
  assert.match(jsRules, /io\.deep\.readFileSync\(concatSource/);
  assert.match(jsRules, /fsp\.readFile\(streamSource/);
  assert.match(jsRules, /io\.fs\.readFileSync\(fdInlineSource/);
  assert.match(jsRules, /concatenatedBlob/);
  assert.match(jsRules, /push\(pushedBlob/);
  assert.match(jsRules, /write\(streamedBlob/);
  assert.match(jsRules, /writeFileSync\(destination, persistedBlob/);
  assert.match(jsRules, /writeSync\(1, fileDescriptorBlob/);

  const shellRules = scanShell(
    'mutation/new-render.sh',
    'def parse_frontmatter(text):\n    return re.match(r"^---\\\\n(.*?)\\\\n---", text, re.DOTALL)\n'
      + 'unsafeRawCapsuleValue "$doc" "not audited"\n',
    new Map(),
    new Map(),
  ).join('\n');
  assert.match(shellRules, /frontmatter-parser-declaration/);
  assert.match(shellRules, /frontmatter-delimiter-parser/);
  assert.match(shellRules, /unaudited-unsafe-raw-call/);
  const embeddedNodeShell = scanShell(
    'mutation/embedded-node.sh',
    `node <<'NODE'\n`
      + 'const fs = require("fs");\n'
      + 'function parseFrontmatter(text) { return text.match(/^---\\\\n([\\\\s\\\\S]*?)\\\\n---/); }\n'
      + 'const raw = fs.readFileSync(capsulePath, "utf8");\n'
      + 'console.log(`objective: ${parseFrontmatter(raw)}`);\n'
      + 'NODE\n'
      + 'copy_missing_tree "$SRC/system" "$TARGET/system" 0\n',
    new Map(),
    new Map(),
  ).join('\n');
  assert.match(embeddedNodeShell, /frontmatter-parser-declaration/);
  assert.match(embeddedNodeShell, /frontmatter-delimiter-parser/);
  assert.match(embeddedNodeShell, /unaudited-tree-copy/);
  const shellParserBypasses = scanShell(
    'mutation/shell-parser-bypasses.sh',
    'front=${doc#*---}\n'
      + 'body=${front%%---*}\n'
      + 'while IFS=: read -r key value; do printf "%s" "$value"; done <<< "$body"\n',
    new Map(),
    new Map(),
    new Map(),
  ).join('\n');
  assert.match(shellParserBypasses, /frontmatter-shell-expansion/);
  assert.match(shellParserBypasses, /frontmatter-shell-field-loop/);
  const variableTreeCopies = scanShell(
    'mutation/variable-copy.sh',
    'procedure_dir="$SRC/system"\n'
      + 'copy_missing_tree "$procedure_dir" "$TARGET/runtime" 0\n'
      + 'cp -r "$procedure_dir" "$TARGET/direct"\n',
    new Map(),
    new Map(),
    new Map(),
  ).join('\n');
  assert.match(variableTreeCopies, /unaudited-tree-copy/);
  assert.match(variableTreeCopies, /copy_missing_tree/);
  assert.match(variableTreeCopies, /cp -r/);
  const indirectShell = scanShell(
    'mutation/indirect.sh',
    'result=$(unsafeRawCapsuleValue "$doc" "not audited")\n',
    new Map(),
    new Map(),
  ).join('\n');
  assert.match(indirectShell, /unsafe-raw-indirect-shell-call/);
  const positionedShell = scanShell(
    'mutation/positioned.sh',
    'command unsafeRawCapsuleValue "$doc" "not audited"\n'
      + 'true; unsafeRawCapsuleValue "$doc" "not audited"\n'
      + 'X=1 unsafeRawCapsuleValue "$doc" "not audited"\n',
    new Map(),
    new Map(),
  ).join('\n');
  assert.match(positionedShell, /unaudited-unsafe-raw-call/);

  const pythonRules = scanPython(
    'mutation/new-render.py',
    'def parse_frontmatter(text):\n    return re.match(r"^---\\\\n(.*?)\\\\n---", text, re.DOTALL)\n'
      + 'raw_alias = unsafeRawScalar\n'
      + 'from render_boundary import (\n    _raw_scalar_token,\n)\n',
    new Map(),
  ).join('\n');
  assert.match(pythonRules, /frontmatter-parser-declaration/);
  assert.match(pythonRules, /frontmatter-delimiter-parser/);
  assert.match(pythonRules, /unsafe-raw-indirection/);
  assert.match(pythonRules, /private-reader-helper-access/);
  const splitPython = scanPython(
    'mutation/split-parser.py',
    "block = text.split('---', 2)[1]\n"
      + "value = next(line.split(':', 1)[1] for line in block.splitlines() "
      + "if line.split(':', 1)[0] == key)\n",
    new Map(),
  ).join('\n');
  assert.match(splitPython, /frontmatter-delimiter-parser/);
  const partitionPython = scanPython(
    'mutation/partition-parser.py',
    "before, marker, frontmatter = text.partition('---')\n"
      + "end = frontmatter.find('---')\n",
    new Map(),
  ).join('\n');
  assert.match(partitionPython, /frontmatter-delimiter-parser/);
  assert.match(partitionPython, /\.partition/);
  assert.match(partitionPython, /\.find/);
  const pythonModuleBypass = scanPython(
    'mutation/module-bypass.py',
    'import daemons.render_boundary as rb\nraw = rb._FRONTMATTER.match(doc)\n',
    new Map(),
  ).join('\n');
  assert.match(pythonModuleBypass, /reader-module-import/);
  assert.match(pythonModuleBypass, /private-reader-helper-access/);
});
