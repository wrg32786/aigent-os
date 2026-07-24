#!/usr/bin/env node
// build-terminal-demo.mjs -- renders a self-contained, looping, animated SVG
// terminal-window recreation of a scripted dialogue. No external assets, no
// dependencies: pure SVG + SMIL <animate>, a monospace font-family stack
// (never an embedded/fetched font), sized and colored to match this repo's
// existing assets/banner.svg palette.
//
// Input: a JSON "script" file --
//   {
//     "title": "string shown in the terminal title bar",
//     "ariaLabel": "accessible description of the whole clip",
//     "turns": [
//       { "speaker": "ai" | "you" | "sys", "lines": ["line one", "line two, wraps if long", ""] }
//     ]
//   }
// "" is a deliberate blank line (paragraph break) -- kept as-is, not wrapped.
//
// Output: a single .svg file, written next to the input unless --out is given.
//
// Usage: node assets/build-terminal-demo.mjs <script.json> [--out <file.svg>]
//
// Why per-line fade-reveal instead of per-character typewriter: a typewriter
// effect needs precise per-glyph timing math for zero payoff here -- the
// point of this asset is "prove the product actually talks like this," not
// win a motion-design award. Per-line fade-in is the boring path that still
// reads as "a live terminal," at a fraction of the SMIL complexity and with
// zero risk of drifting out of sync with re-wrapped text.
//
// Looping: every reveal is expressed as a keyTimes/values animation over the
// SAME total cycle length T with repeatCount="indefinite" -- there is no
// nested time container to keep in sync, and the whole clip restarts cleanly
// every loop.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const COLS = 78;
const FONT_SIZE = 14;
const LINE_HEIGHT = 20;
const PAD_X = 22;
const PAD_TOP = 46; // chrome header height
const PAD_BOTTOM = 20;
const WIDTH = 860;
const CHAR_W = 8.4; // approximate monospace advance at FONT_SIZE 14
const REVEAL_FADE_S = 0.35;
const GAP_AFTER_TURN_S = 0.55;
const HOLD_TAIL_S = 3.5; // how long the finished screen sits before looping
const CURSOR_BLINK_S = 0.9;

const COLORS = {
  bg: '#0b0f16',
  chrome: '#131a24',
  border: '#232c39',
  dot: ['#ff5f56', '#ffbd2e', '#27c93f'],
  title: '#7d8a9c',
  ai: '#10b981',
  you: '#6366f1',
  sys: '#5b6472',
  text: '#c9d1d9',
  cursor: '#10b981',
};

function wrap(line, cols) {
  if (line === '') return [''];
  const words = line.split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > cols && cur) {
      out.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function speakerLabel(speaker) {
  if (speaker === 'ai') return 'AI:';
  if (speaker === 'you') return 'You:';
  return '';
}

function build(script) {
  const prefixCols = 5; // "AI:  " / "You: " column width
  const bodyCols = COLS - prefixCols;

  // Flatten turns into rendered rows, tracking which row starts a new turn
  // (for the reveal beat) and which turn/beat index each row belongs to.
  const rows = []; // { text, speaker, beat, isFirstOfBeat }
  let beat = 0;
  for (const turn of script.turns) {
    let firstRow = true;
    for (const raw of turn.lines) {
      const wrapped = wrap(raw, bodyCols);
      for (const w of wrapped) {
        const prefix = firstRow ? speakerLabel(turn.speaker).padEnd(prefixCols) : ''.padEnd(prefixCols);
        rows.push({ text: prefix + w, speaker: turn.speaker, beat, isFirstOfBeat: firstRow });
        firstRow = false;
      }
    }
    beat += 1;
  }
  const totalBeats = beat;

  const height = PAD_TOP + rows.length * LINE_HEIGHT + PAD_BOTTOM;

  // Timing: each beat reveals all its rows together (a "turn" appears at
  // once, matching how a real reply streams in as one message).
  const beatStart = [];
  let t = 0.6; // small lead-in before the first beat
  for (let b = 0; b < totalBeats; b++) {
    beatStart.push(t);
    const rowsInBeat = rows.filter((r) => r.beat === b).length;
    // Longer turns hold the eye a little longer before the next one lands.
    t += REVEAL_FADE_S + Math.min(rowsInBeat * 0.28, 2.2) + GAP_AFTER_TURN_S;
  }
  const lastReveal = beatStart[totalBeats - 1] ?? 0.6;
  const total = lastReveal + REVEAL_FADE_S + HOLD_TAIL_S;

  const rowSvgs = rows.map((r, i) => {
    const y = PAD_TOP + i * LINE_HEIGHT;
    const start = beatStart[r.beat];
    const fadeFrac = (REVEAL_FADE_S / total).toFixed(6);
    const startFrac = (start / total).toFixed(6);
    const endFrac = Math.min(Number(startFrac) + Number(fadeFrac), 0.999999).toFixed(6);
    const color = COLORS[r.speaker] ?? COLORS.text;
    const weight = r.isFirstOfBeat && r.speaker !== 'sys' ? '600' : '400';
    const style = r.speaker === 'sys' ? ' font-style="italic"' : '';
    return `    <text x="${PAD_X}" y="${y}" fill="${color}" font-weight="${weight}"${style} xml:space="preserve">${esc(r.text)}` +
      `<animate attributeName="opacity" dur="${total.toFixed(2)}s" repeatCount="indefinite" calcMode="linear" ` +
      `keyTimes="0;${startFrac};${endFrac};1" values="0;0;1;1"/></text>`;
  }).join('\n');

  // Blinking cursor: idle-blinks after the last line finishes, until the loop resets.
  const cursorRow = rows.length - 1;
  const cursorX = PAD_X + (rows[cursorRow]?.text.length ?? 0) * CHAR_W + 4;
  const cursorY = PAD_TOP + cursorRow * LINE_HEIGHT - FONT_SIZE + 2;
  const cursorOnFrac = ((lastReveal + REVEAL_FADE_S) / total).toFixed(6);
  const blinkCount = Math.max(1, Math.floor((total - (lastReveal + REVEAL_FADE_S)) / CURSOR_BLINK_S));
  const blinkKeyTimes = ['0', cursorOnFrac];
  const blinkValues = ['0', '0'];
  for (let i = 0; i < blinkCount; i++) {
    const on = Number(cursorOnFrac) + ((i + 0.5) * CURSOR_BLINK_S) / total;
    const off = Number(cursorOnFrac) + ((i + 1) * CURSOR_BLINK_S) / total;
    if (off >= 1) break;
    blinkKeyTimes.push(on.toFixed(6), off.toFixed(6));
    blinkValues.push('1', '0');
  }
  blinkKeyTimes.push('1');
  blinkValues.push('0');

  const dots = COLORS.dot.map((c, i) => `<circle cx="${20 + i * 18}" cy="16" r="6" fill="${c}"/>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" aria-label="${esc(script.ariaLabel || script.title || 'aigent-OS terminal demo')}">
  <defs>
    <style>
      text { font-family: ui-monospace, SFMono-Regular, "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace; font-size: ${FONT_SIZE}px; }
    </style>
  </defs>
  <rect x="0" y="0" width="${WIDTH}" height="${height}" rx="10" fill="${COLORS.bg}"/>
  <rect x="0" y="0" width="${WIDTH}" height="${height}" rx="10" fill="none" stroke="${COLORS.border}" stroke-width="1"/>
  <rect x="0" y="0" width="${WIDTH}" height="${PAD_TOP - 12}" rx="10" fill="${COLORS.chrome}"/>
  <rect x="0" y="${PAD_TOP - 22}" width="${WIDTH}" height="12" fill="${COLORS.chrome}"/>
  ${dots}
  <text x="${WIDTH / 2}" y="${PAD_TOP - 22}" fill="${COLORS.title}" text-anchor="middle" font-size="12">${esc(script.title || '')}</text>
${rowSvgs}
  <rect x="${cursorX}" y="${cursorY}" width="8" height="${FONT_SIZE}" fill="${COLORS.cursor}">
    <animate attributeName="opacity" dur="${total.toFixed(2)}s" repeatCount="indefinite" calcMode="discrete" keyTimes="${blinkKeyTimes.join(';')}" values="${blinkValues.join(';')}"/>
  </rect>
</svg>
`;
}

function main() {
  const args = process.argv.slice(2);
  const input = args[0];
  if (!input) {
    console.error('Usage: node assets/build-terminal-demo.mjs <script.json> [--out <file.svg>]');
    process.exit(2);
  }
  const outIdx = args.indexOf('--out');
  const outPath = outIdx !== -1 ? args[outIdx + 1] : input.replace(/\.script\.json$/, '.svg');

  const script = JSON.parse(readFileSync(input, 'utf8'));
  const svg = build(script);
  writeFileSync(outPath, svg);
  console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
}

main();
