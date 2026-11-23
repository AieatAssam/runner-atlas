import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const emblem = readFileSync(new URL('../../site/assets/emblem.svg', import.meta.url), 'utf8').trim();
const publicDir = new URL('../../site/public/', import.meta.url);
const light = { ink: '#1a2834', paper: '#f3f0e7' };
const dark = { ink: '#efebe0', paper: '#0e151b' };

function icon(markSize: number, adaptive = false): string {
  const offset = (32 - markSize) / 2;
  const mark = emblem.replace('<svg ', `<svg x="${offset}" y="${offset}" width="${markSize}" height="${markSize}" `);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <style>
    svg { color: ${light.ink}; }
    .paper { fill: ${light.paper}; }${adaptive ? `
    @media (prefers-color-scheme: dark) {
      svg { color: ${dark.ink}; }
      .paper { fill: ${dark.paper}; }
    }` : ''}
  </style>
  <rect class="paper" width="32" height="32"/>
  ${mark}
</svg>
`;
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ colorScheme: 'light', deviceScaleFactor: 1 });
  const outputs = [
    { file: 'favicon-32.png', size: 32, mark: 24, cap: 4_000 },
    { file: 'apple-touch-icon.png', size: 180, mark: 22.4, cap: 40_000 },
    // A square at 56% width fits within the circular safe zone with radius 40%.
    { file: 'icon-512.png', size: 512, mark: 17.92, cap: 40_000 },
  ];
  for (const { file, size, mark, cap } of outputs) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><style>body{margin:0}body>svg{display:block;width:100vw;height:100vh}</style>${icon(mark)}`);
    const png = await page.screenshot();
    assert(png.byteLength <= cap, `${file} exceeds ${cap} bytes`);
    writeFileSync(new URL(file, publicDir), png);
  }
  writeFileSync(new URL('favicon.svg', publicDir), icon(24, true));
} finally {
  await browser.close();
}
