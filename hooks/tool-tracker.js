'use strict';

// Privacy-preserving tool activity tracker for Claude Code hooks.
// Records action metadata only. It never persists file contents, raw shell
// commands, MCP queries, channel IDs, or arbitrary fallback input.

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, '[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]'],
  [/\bBasic\s+[A-Za-z0-9+/=]+/gi, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]'],
  [/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*["']?[^\s"']+/gi, '[REDACTED]'],
  [/\b(?:sk|pk|ghp|github_pat|xox[baprs]|AKIA)[-_A-Za-z0-9]{12,}\b/g, '[REDACTED]'],
  [/([a-z][a-z0-9+.-]*:\/\/[^\s:/]+:)[^@\s]+@/gi, '$1[REDACTED]@'],
];

function redact(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function compact(value, limit = 160) {
  return redact(value).replace(/\s+/g, ' ').trim().slice(0, limit);
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
  if (!normalizedRoot) return compact(fp);
  return compact(fp.startsWith(`${normalizedRoot}/`) ? fp.slice(normalizedRoot.length + 1) : fp);
}

function describeTool(tool, input, env = process.env) {
  switch (tool) {
    case 'Edit':
    case 'Write':
      return relativePath(input.file_path, env.AIGENT_ROOT || '.');
    case 'Bash':
      return classifyBash(input.command);
    case 'Agent':
      return compact(input.description || 'agent dispatch');
    case 'TaskCreate':
    case 'TaskUpdate':
      return compact(input.subject || input.taskId || 'task update');
    case 'Skill':
      return compact(input.skill || 'skill invocation');
    default:
      if (tool.startsWith('mcp__')) {
        const parts = tool.split('__');
        return compact(`${parts[1] || 'mcp'}/${parts[2] || 'tool'}`);
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
  return `- ${time} | ${compact(tool, 80)} | ${description}`;
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
  redact,
};
