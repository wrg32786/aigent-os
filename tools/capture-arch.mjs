#!/usr/bin/env node
/**
 * Deterministic frame capture for docs/architecture/index.html.
 *
 * Drives headless Chromium (Playwright) through N evenly spaced points of a
 * full 360-degree camera orbit (frame=K, total=N -> angle = 2*PI*K/N), waits
 * for the page's own window.__frameReady signal (set after two rAF-flushed
 * render passes so the frame is fully drawn), and screenshots each one.
 *
 * Prerequisite: Playwright + a Chromium build must be installed —
 *   npm i -D playwright && npx playwright install chromium
 *
 * Assemble the resulting frames/frame_%03d.png sequence into a GIF with
 * ffmpeg's two-pass palette workflow:
 *   ffmpeg -y -i frames/frame_%03d.png -vf "fps=15,scale=1000:-1:flags=lanczos,palettegen" /tmp/palette.png
 *   ffmpeg -y -i frames/frame_%03d.png -i /tmp/palette.png -lavfi "fps=15,scale=1000:-1:flags=lanczos [x]; [x][1:v] paletteuse" assets/architecture.gif
 *
 * Usage: node tools/capture-arch.mjs [--frames 60] [--width 1000] [--height 625] [--out frames]
 */
import { chromium } from 'playwright';
import { mkdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const TOTAL = parseInt(arg('frames', '60'), 10);
const WIDTH = parseInt(arg('width', '1000'), 10);
const HEIGHT = parseInt(arg('height', '625'), 10);
const OUT_DIR = path.resolve(repoRoot, arg('out', 'frames'));
const HTML_PATH = path.resolve(repoRoot, 'docs/architecture/index.html');

if (!existsSync(HTML_PATH)) {
  console.error(`Scene not found: ${HTML_PATH}`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

const baseUrl = pathToFileURL(HTML_PATH).href;

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swapchain', '--ignore-gpu-blocklist'],
  });

  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });

  // Sanity check: confirm WebGL actually renders (not a black/blank context)
  // before burning time on all N frames.
  await page.goto(`${baseUrl}?frame=0&total=${TOTAL}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__frameReady === true', { timeout: 15000 });
  const glCheck = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
    return { hasCanvas: !!canvas, hasGL: !!gl, w: canvas?.width, h: canvas?.height };
  });
  console.log('WebGL sanity check:', JSON.stringify(glCheck));
  if (!glCheck.hasGL) {
    console.error('WebGL context unavailable in headless Chromium — aborting before capturing a black GIF.');
    await browser.close();
    process.exit(1);
  }

  const frame0Path = path.join(OUT_DIR, 'frame_000.png');
  await page.screenshot({ path: frame0Path });
  const frame0Size = statSync(frame0Path).size;
  console.log(`frame_000.png: ${frame0Size} bytes`);
  if (frame0Size < 3000) {
    console.error(`frame_000.png is suspiciously small (${frame0Size} bytes) — likely a black/blank frame. Aborting.`);
    await browser.close();
    process.exit(1);
  }

  for (let k = 1; k < TOTAL; k++) {
    await page.goto(`${baseUrl}?frame=${k}&total=${TOTAL}`, { waitUntil: 'load' });
    await page.waitForFunction('window.__frameReady === true', { timeout: 15000 });
    const filename = `frame_${String(k).padStart(3, '0')}.png`;
    await page.screenshot({ path: path.join(OUT_DIR, filename) });
    if (k % 10 === 0 || k === TOTAL - 1) console.log(`captured ${k + 1}/${TOTAL}`);
  }

  await browser.close();
  console.log(`Done. ${TOTAL} frames written to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
