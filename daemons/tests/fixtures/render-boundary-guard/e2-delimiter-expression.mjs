const DELIMITER = '-'.repeat(3);

function capsuleField(text, key) {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[0].slice(0, DELIMITER.length) !== DELIMITER) return '';
  for (const line of lines.slice(1)) {
    if (line.slice(0, key.length + 1) === `${key}:`) {
      return line.slice(key.length + 1).trim();
    }
    if (line.slice(0, DELIMITER.length) === DELIMITER) break;
  }
  return '';
}

export const rendered = `objective: ${capsuleField(capsuleText, 'objective')}`;
