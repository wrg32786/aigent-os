'use strict';

// Privacy-preserving tool activity tracker for Claude Code hooks.
// Records action metadata only. It never persists file contents, raw shell
// commands, MCP queries, channel IDs, or arbitrary fallback input.

let redact = () => '[REDACTOR UNAVAILABLE]';
try {
  ({ redact } = require('../daemons/redact.cjs'));
} catch {
  process.stderr.write('tool-tracker: shared redactor unavailable; captured values suppressed\n');
}

// A captured value is persisted in a Markdown list and later summarized into
// model-facing orientation. Collapse every character that can create a visual
// or physical line boundary before it reaches either renderer.
const LINE_BREAKING = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function compact(value, limit = 160) {
  const text = redact(value)
    .replace(LINE_BREAKING, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]`;
}

function inert(value, limit = 160) {
  return JSON.stringify(compact(value, limit));
}

function classifyBash(command) {
  const normalized = String(command ?? '').trim().toLowerCase();
  if (!normalized) return 'shell command';
  if (/^(git|gh)\b/.test(normalized)) return 'version-control command';
  if (/^(npm|pnpm|yarn|bun)\b/.test(normalized)) return 'package/build command';
  if (/^(pytest|python\s+-m\s+pytest|npm\s+test|pnpm\s+test|yarn\s+test|node\s+--test|go\s+test|cargo\s+test|make\s+test)\b/.test(normalized)) return 'test command';
  if (/^(curl|wget|http|https)\b/.test(normalized)) return 'network command';
  if (/^(cp|mv|rm|mkdir|rmdir|touch|chmod|chown|ln|rsync)\b/.test(normalized)) return 'filesystem command';
  if (/^(docker|podman|kubectl|helm|terraform|ansible)\b/.test(normalized)) return 'infrastructure command';
  return 'shell command';
}

function relativePath(filePath, root) {
  const fp = String(filePath ?? '').replace(/\\/g, '/');
  const normalizedRoot = String(root ?? '').replace(/\\/g, '/').replace(/\/$/, '');
  if (!normalizedRoot) return fp;
  return fp.startsWith(`${normalizedRoot}/`) ? fp.slice(normalizedRoot.length + 1) : fp;
}

function describeTool(tool, input, env = process.env) {
  switch (tool) {
    case 'Edit':
    case 'Write':
      return relativePath(input.file_path, env.AIGENT_ROOT || '.');
    case 'Bash':
      return classifyBash(input.command);
    case 'Agent':
      return input.description || 'agent dispatch';
    case 'TaskCreate':
    case 'TaskUpdate':
      return input.subject || input.taskId || 'task update';
    case 'Skill':
      return input.skill || 'skill invocation';
    default:
      if (tool.startsWith('mcp__')) {
        const parts = tool.split('__');
        return `${parts[1] || 'mcp'}/${parts[2] || 'tool'}`;
      }
      return '';
  }
}

function formatCapture(event, env = process.env, now = new Date()) {
  const tool = typeof event.tool_name === 'string' ? event.tool_name : '';
  const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
  if (!tool) return '';

  const readOnly = new Set([
    'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch',
    'TaskGet', 'TaskList', 'NotebookRead', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
  ]);
  if (readOnly.has(tool)) return '';

  const description = describeTool(tool, input, env);
  if (!description) return '';
  const time = now.toTimeString().slice(0, 8);
  return `- ${time} | ${inert(tool, 80)} | ${inert(description, 160)}`;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const event = JSON.parse(raw || '{}');
      const capture = formatCapture(event);
      if (capture) process.stdout.write(`${capture}\n`);
    } catch {
      process.exitCode = 0;
    }
  });
}

if (require.main === module) main();

module.exports = {
  classifyBash,
  compact,
  describeTool,
  formatCapture,
  inert,
  redact,
};
