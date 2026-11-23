import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { mapPaths } from './plates.ts';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, colorScheme: 'light' });
  await page.goto(new URL('./og-card.html', import.meta.url).href);
  await page.locator('svg').evaluate((svg, paths) => { svg.innerHTML = paths; }, mapPaths);
  const fontsLoaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.size === 2 && [...document.fonts].every(face => face.status === 'loaded');
  });
  assert(fontsLoaded, 'Expected both bundled faces to load');
  const png = await page.screenshot();
  assert(png.byteLength <= 300_000, 'Social card exceeds 300 KB');
  writeFileSync(new URL('../../site/public/og-card.png', import.meta.url), png);
} finally {
  await browser.close();
}
