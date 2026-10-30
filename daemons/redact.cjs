'use strict';

// Shared credential redaction for installed hooks and daemon writers.
const SECRET_PATTERNS = [
  [/\\"(password|passwd|token|secret|api_key|apiKey|access_token|refresh_token|client_secret|key)\\"\s*:\s*\\"[^"\\]*/gi, '\\"$1\\":\\"[REDACTED]'],
  [/\\'(password|passwd|token|secret|api_key|apiKey|access_token|refresh_token|client_secret|key)\\'\s*:\s*\\'[^'\\]*/gi, "\\'$1\\':\\'[REDACTED]"],
  [/(\bgh\s+(?:secret|variable)\s+set\s+\S+\s+(?:[^\r\n;|&]*?\s)?(?:--body(?:\s+|=)|-b\s+))("(?:\\.|[^"\\])*"|'[^']*'|[^\s;|&]+)/gi, '$1[REDACTED]'],
  [/(\bgh\s+(?:secret|variable)\s+set\s+\S+\s+)(?!-)("(?:\\.|[^"\\])*"|'[^']*'|[^\s;|&]+)/gi, '$1[REDACTED]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, '[REDACTED]'],
  [/"(X-Api-Key|apikey|Authorization|Cookie|Set-Cookie|X-Auth-Token|Private-Token)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"'],
  [/"(token|secret|password|passwd|api_key|apiKey|access_token|refresh_token|client_secret|key)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"'],
  [/(^|\s)((?:-u|--user)\s+)[^\s:]+:[^\s]+/g, '$1$2[REDACTED]'],
  [/(^|\s)((?:-H\s*|--header(?:\s+|=))["']?)(X-Api-Key|apikey|Authorization|Cookie|Set-Cookie|X-Auth-Token|Private-Token)\s*:\s*[^'"\r\n]+/gi, '$1$2$3: [REDACTED]'],
  [/(?<!\w)(?:--)?(?:(?:[\w]+[_-])+(?:token|secret|password|access[_-]key)|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|password|passwd|private[_-]?key|x-api-key|api-key)\s*[:=]\s*(?!\[REDACTED\])(?:"[^"\r\n]*"|'[^'\r\n]*')/gi, '[REDACTED]'],
  [/(?<!\w)(?:--)?(?:(?:[\w]+[_-])+(?:token|secret|password|access[_-]key)|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|password|passwd|private[_-]?key|x-api-key|api-key)\s*[:=]\s*(?!\s|\[REDACTED\])[^\s"'&,;)}\]]+/gi, '[REDACTED]'],
  [/(?:--token|--password|--api-key)\s+["']?[^\s"']+/gi, '[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]'],
  [/\bBasic\s+[A-Za-z0-9+/=]+/gi, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]'],
  [/\b(?:glpat-|github_pat_)[A-Za-z0-9_-]+\b/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\b(?:sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9_-]+|xox[baprs]-[^\s"']+)/g, '[REDACTED]'],
  [/\b(?:(?:pk|ghp)[-_A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9_-]+)\b/g, '[REDACTED]'],
  [/([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):[^@\s/]+@/gi,
    (_, scheme, user) => `${scheme}${/^https?:/i.test(scheme) ? '' : `${user}:`}[REDACTED]@`],
];

function redact(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

module.exports = { SECRET_PATTERNS, redact };
