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
// Reveal model:
//   - ai / sys turns fade in a line at a time -- that reads as a reply
//     streaming in as one message, which is how the model actually talks.
//   - `you` turns TYPE OUT character by character with a moving caret -- the
//     human input is the part a viewer expects to watch being written, so it
//     gets a real typewriter effect (discrete per-glyph reveal + a caret that
//     advances with it), not a fade.
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

// Pacing (deliberately unhurried -- the point is legibility, not speed).
const REVEAL_FADE_S = 0.45;      // how long a streamed (ai/sys) line takes to fade in
const DWELL_PER_ROW_S = 0.42;    // extra hold per row of a streamed turn, so long replies linger
const DWELL_CAP_S = 3.2;         // ceiling on that per-turn hold
const GAP_AFTER_TURN_S = 0.9;    // beat of stillness between turns
const CHAR_TYPE_S = 0.058;       // per-character type speed for `you` lines
const TYPE_LEAD_S = 0.35;        // the label fades in, then typing starts
const GAP_AFTER_TYPE_S = 0.95;   // hold after a typed line finishes
const LEAD_IN_S = 0.7;           // small lead-in before the first beat
const HOLD_TAIL_S = 4.0;         // how long the finished screen sits before looping
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
  caret: '#6366f1', // typing caret on `you` lines, matches the `you` color
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

  // Flatten turns into rendered rows, keeping prefix and body separate so a
  // `you` row can fade its label in and then type its body out independently.
  const rows = []; // { prefix, body, speaker, beat, isFirstOfBeat }
  let beat = 0;
  for (const turn of script.turns) {
    let firstRow = true;
    for (const raw of turn.lines) {
      const wrapped = wrap(raw, bodyCols);
      for (const w of wrapped) {
        const prefix = firstRow ? speakerLabel(turn.speaker).padEnd(prefixCols) : '';
        rows.push({ prefix, body: w, speaker: turn.speaker, beat, isFirstOfBeat: firstRow });
        firstRow = false;
      }
    }
    beat += 1;
  }
  const totalBeats = beat;
  const height = PAD_TOP + rows.length * LINE_HEIGHT + PAD_BOTTOM;

  // ---- Timing walk (seconds). Produces a timing descriptor per row. ----
  const timing = rows.map(() => null);
  let t = LEAD_IN_S;
  for (let b = 0; b < totalBeats; b++) {
    const idxs = rows.map((_, i) => i).filter((i) => rows[i].beat === b);
    const speaker = rows[idxs[0]].speaker;

    if (speaker === 'you') {
      // Type row by row, character by character.
      let clock = t;
      for (const i of idxs) {
        const chars = [...rows[i].body];
        const labelStart = clock;
        const typeStart = clock + TYPE_LEAD_S;
        const charTimes = chars.map((_, k) => typeStart + k * CHAR_TYPE_S);
        const rowEnd = typeStart + chars.length * CHAR_TYPE_S;
        timing[i] = { kind: 'type', labelStart, typeStart, charTimes, rowEnd };
        clock = rowEnd;
      }
      t = clock + GAP_AFTER_TYPE_S;
    } else {
      const start = t;
      for (const i of idxs) timing[i] = { kind: 'fade', start };
      const dwell = Math.min(idxs.length * DWELL_PER_ROW_S, DWELL_CAP_S);
      t = start + REVEAL_FADE_S + dwell + GAP_AFTER_TURN_S;
    }
  }

  // Total cycle length: last visible moment + tail hold.
  let lastReveal = LEAD_IN_S;
  for (let i = 0; i < rows.length; i++) {
    const rt = timing[i];
    lastReveal = Math.max(lastReveal, rt.kind === 'fade' ? rt.start + REVEAL_FADE_S : rt.rowEnd);
  }
  const total = lastReveal + HOLD_TAIL_S;
  const F = (s) => Math.min(Math.max(s / total, 0), 0.999999).toFixed(6);
  const DUR = total.toFixed(2);

  // ---- Render ----
  const bodyX = PAD_X + prefixCols * CHAR_W;

  const rowSvgs = rows.map((r, i) => {
    const y = PAD_TOP + i * LINE_HEIGHT;
    const rt = timing[i];

    if (rt.kind === 'fade') {
      const color = COLORS[r.speaker] ?? COLORS.text;
      const weight = r.isFirstOfBeat && r.speaker !== 'sys' ? '600' : '400';
      const style = r.speaker === 'sys' ? ' font-style="italic"' : '';
      const s = F(rt.start);
      const e = F(rt.start + REVEAL_FADE_S);
      const txt = r.prefix + r.body;
      return `    <text x="${PAD_X}" y="${y}" fill="${color}" font-weight="${weight}"${style} xml:space="preserve">${esc(txt)}` +
        `<animate attributeName="opacity" dur="${DUR}s" repeatCount="indefinite" calcMode="linear" ` +
        `keyTimes="0;${s};${e};1" values="0;0;1;1"/></text>`;
    }

    // `you` typewriter row.
    const chars = [...r.body];
    let out = '';

    // Label ("You: ") fades in just before typing begins.
    if (r.prefix.trim()) {
      const ls = F(rt.labelStart);
      const le = F(rt.labelStart + TYPE_LEAD_S);
      out += `    <text x="${PAD_X}" y="${y}" fill="${COLORS.you}" font-weight="600" xml:space="preserve">${esc(r.prefix)}` +
        `<animate attributeName="opacity" dur="${DUR}s" repeatCount="indefinite" calcMode="linear" ` +
        `keyTimes="0;${ls};${le};1" values="0;0;1;1"/></text>\n`;
    }

    // Body: one <tspan> per glyph, revealed discretely at its type time.
    // Opacity does not affect layout, so glyphs hold their monospace slot from
    // the start -- no reflow as the line types.
    const tspans = chars.map((ch, k) => {
      const cs = F(rt.charTimes[k]);
      return `<tspan opacity="0">${esc(ch)}<animate attributeName="opacity" dur="${DUR}s" ` +
        `repeatCount="indefinite" calcMode="discrete" keyTimes="0;${cs};1" values="0;1;1"/></tspan>`;
    }).join('');
    out += `    <text x="${bodyX}" y="${y}" fill="${COLORS.text}" xml:space="preserve">${tspans}</text>`;

    // Moving caret: visible only while this row types, stepping one glyph at a
    // time. x steps discretely with each character; opacity gates the window.
    if (chars.length) {
      const caretY = y - FONT_SIZE + 2;
      const xKeyTimes = ['0'];
      const xValues = [String(bodyX)];
      for (let k = 0; k <= chars.length; k++) {
        xKeyTimes.push(F(rt.typeStart + k * CHAR_TYPE_S));
        xValues.push((bodyX + k * CHAR_W).toFixed(1));
      }
      xKeyTimes.push('1');
      xValues.push((bodyX + chars.length * CHAR_W).toFixed(1));
      const onS = F(rt.typeStart);
      const offS = F(rt.rowEnd + 0.06);
      out += `\n    <rect y="${caretY}" width="8" height="${FONT_SIZE}" fill="${COLORS.caret}" opacity="0">` +
        `<animate attributeName="opacity" dur="${DUR}s" repeatCount="indefinite" calcMode="discrete" ` +
        `keyTimes="0;${onS};${offS};1" values="0;1;0;0"/>` +
        `<animate attributeName="x" dur="${DUR}s" repeatCount="indefinite" calcMode="discrete" ` +
        `keyTimes="${xKeyTimes.join(';')}" values="${xValues.join(';')}"/></rect>`;
    }
    return out;
  }).join('\n');

  // Resting cursor: blinks at the end of the last row once everything is shown.
  const cursorRow = rows.length - 1;
  const lastLen = (rows[cursorRow].prefix + rows[cursorRow].body).length;
  const cursorX = PAD_X + lastLen * CHAR_W + 4;
  const cursorY = PAD_TOP + cursorRow * LINE_HEIGHT - FONT_SIZE + 2;
  const cursorOnFrac = Number(F(lastReveal));
  const blinkKeyTimes = ['0', cursorOnFrac.toFixed(6)];
  const blinkValues = ['0', '0'];
  const blinkCount = Math.max(1, Math.floor((total - lastReveal) / CURSOR_BLINK_S));
  for (let i = 0; i < blinkCount; i++) {
    const on = cursorOnFrac + ((i + 0.5) * CURSOR_BLINK_S) / total;
    const off = cursorOnFrac + ((i + 1) * CURSOR_BLINK_S) / total;
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
    <animate attributeName="opacity" dur="${DUR}s" repeatCount="indefinite" calcMode="discrete" keyTimes="${blinkKeyTimes.join(';')}" values="${blinkValues.join(';')}"/>
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
