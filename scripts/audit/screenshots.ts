// Audit screenshots (SPEC 8, M11). Builds each synthetic day preset, serves it with `vite preview` on a free port,
// and captures full-page PNGs into audit/screenshots/. Every request leaving localhost is aborted and counted.
//   npm run audit:screenshots
import { createServer, type AddressInfo } from 'node:net';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { REPO, buildFixture, startPreview, syntheticRollups } from '../fixtures.ts';

const DAYS = [0, 1, 3, 7, 14, 30, 90] as const;
const WIDTHS = [375, 1280, 1440] as const;
const THEMES = ['light', 'dark'] as const;
const OUT = join(REPO, 'audit', 'screenshots');
const DIST_ROOT = join(REPO, '.tmp', 'audit-dist');
// SwiftShader WebGL. ANGLE-over-SwiftShader fails to capture pages taller than about 8k px.
const GL_ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'];

type Theme = (typeof THEMES)[number];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitUp(url: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`preview never answered at ${url}`);
}

// Localhost only. Anything else is aborted and counted; the caller fails the run on a non-zero count.
async function guard(context: BrowserContext, origin: string): Promise<{ external: () => number }> {
  let external = 0;
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    external += 1;
    return route.abort();
  });
  return { external: () => external };
}

// Brings every open panel into view one at a time and waits for it to leave "loading" (SPEC 6.6 states).
// A fast scroll can skip the lazy trigger, so each loading panel is scrolled to on its own.
async function settle(page: Page): Promise<void> {
  const loading = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('section.panel[data-panel]')].filter((s) => s.dataset.state === 'loading').map((s) => s.dataset.panel ?? ''));
  for (const id of loading) {
    const panel = page.locator(`section.panel[data-panel="${id}"]`);
    await panel.scrollIntoViewIfNeeded();
    await page.waitForFunction(
      (name) => document.querySelector<HTMLElement>(`section.panel[data-panel="${name}"]`)?.dataset.state !== 'loading',
      id,
      { timeout: 60_000 },
    ).catch(() => { throw new Error(`panel ${id} still loading after 60 s`); });
  }
  const errored = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('section.panel[data-panel]')].filter((s) => s.dataset.state === 'error').map((s) => s.dataset.panel));
  if (errored.length) throw new Error(`panels in error state: ${errored.join(', ')}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

// Full page. Chromium refuses captures taller than 16 000 px, so pages are taken in 8 000 px clips and stitched.
async function fullShot(page: Page, path: string): Promise<void> {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const viewport = page.viewportSize() ?? { width: 1280, height: 900 };
  const TILE = 8000;
  if (height <= TILE) {
    await page.setViewportSize({ width: viewport.width, height });
    await page.waitForTimeout(300);
    await page.screenshot({ path });
    await page.setViewportSize(viewport);
    return;
  }
  const parts: Buffer[] = [];
  for (let top = 0; top < height; top += TILE) {
    parts.push(await page.screenshot({ fullPage: true, clip: { x: 0, y: top, width: viewport.width, height: Math.min(TILE, height - top) } }));
  }
  writeFileSync(path, stitchPng(parts));
}

// Joins PNGs of equal width (8-bit RGB or RGBA, non-interlaced, as Chromium writes them) top to bottom.
function stitchPng(parts: Buffer[]): Buffer {
  const rows: Buffer[] = [];
  let width = 0;
  let colorType = 6;
  for (const part of parts) {
    let pos = 8;
    const idat: Buffer[] = [];
    while (pos < part.length) {
      const len = part.readUInt32BE(pos);
      const type = part.toString('ascii', pos + 4, pos + 8);
      const data = part.subarray(pos + 8, pos + 8 + len);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        colorType = data[9] ?? 6;
        if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG layout');
      }
      if (type === 'IDAT') idat.push(data);
      pos += 12 + len;
    }
    const bpp = colorType === 6 ? 4 : 3;
    const stride = width * bpp;
    const raw = inflateSync(Buffer.concat(idat));
    const height = raw.length / (stride + 1);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? line[x - bpp]! : 0;
        const b = prev[x]!;
        const c = x >= bpp ? prev[x - bpp]! : 0;
        if (filter === 1) line[x] = (line[x]! + a) & 255;
        else if (filter === 2) line[x] = (line[x]! + b) & 255;
        else if (filter === 3) line[x] = (line[x]! + ((a + b) >> 1)) & 255;
        else if (filter === 4) {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[x] = (line[x]! + pred) & 255;
        }
      }
      rows.push(Buffer.concat([Buffer.from([0]), line]));
      prev = line;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

async function newPage(browser: Browser, origin: string, width: number, theme: Theme): Promise<{ page: Page; context: BrowserContext; external: () => number; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
  await context.addInitScript((t) => window.localStorage.setItem('atlas-theme', t), theme);
  const { external } = await guard(context, origin);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return { page, context, external, errors };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: GL_ARGS });
  const written: string[] = [];
  let external = 0;
  const errors: string[] = [];

  for (const days of DAYS) {
    const dist = join(DIST_ROOT, `day-${days}`);
    buildFixture(syntheticRollups(days), dist);
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const server = startPreview(dist, port);
    try {
      await waitUp(`${origin}/`);
      for (const width of WIDTHS) {
        for (const theme of THEMES) {
          const name = `day-${days}-${width}-${theme}.png`;
          const { page, context, external: ext, errors: errs } = await newPage(browser, origin, width, theme);
          await page.goto(`${origin}/`, { waitUntil: 'load' });
          await settle(page);
          await fullShot(page, join(OUT, name));
          written.push(name);
          external += ext();
          errors.push(...errs.map((e) => `day-${days} ${name}: ${e}`));
          await context.close();
        }
      }
      if (days === 90) external += await captureDay90Extras(browser, origin, written, errors);
    } finally {
      server.kill('SIGTERM');
    }
  }

  await browser.close();
  if (external > 0) throw new Error(`${external} request(s) left localhost`);
  if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
  const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
  console.log(`wrote ${written.length} screenshots, ${count} PNGs in audit/screenshots, 0 external requests`);
}

// Day-90 extras: the 2D fallbacks without WebGL, each 3D scene on its own, and the Methods section.
async function captureDay90Extras(browser: Browser, origin: string, written: string[], errors: string[]): Promise<number> {
  let external = 0;
  {
    const noGl = await chromium.launch({ args: ['--disable-webgl'] });
    const { page, context, external: ext, errors: errs } = await newPage(noGl, origin, 1280, 'light');
    await page.goto(`${origin}/`, { waitUntil: 'load' });
    await settle(page);
    const canvases = await page.locator('.scene canvas').count();
    if (canvases !== 0) throw new Error(`nowebgl run mounted ${canvases} canvas element(s)`);
    await fullShot(page, join(OUT, 'day-90-1280-light-nowebgl.png'));
    written.push('day-90-1280-light-nowebgl.png');
    errors.push(...errs);
    external += ext();
    await context.close();
    await noGl.close();
  }

  const { page, context, external: ext, errors: errs } = await newPage(browser, origin, 1280, 'light');
  // Tall enough that the tallest scene fits below the sticky title strip; scene sizes follow width only.
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  await settle(page);
  for (const [id, file] of [['terrain', 'day-90-3d-terrain.png'], ['pointcloud', 'day-90-3d-pointcloud.png'], ['globe', 'day-90-3d-globe.png']] as const) {
    const scene = page.locator(`section[data-panel="${id}"] .scene`);
    // block 'start' honours the page's scroll-padding-top, which clears the sticky strip as it does for readers.
    await scene.evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await page.locator(`section[data-panel="${id}"] .scene canvas`).waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(500);
    const { top, bottom, strip } = await scene.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, strip: document.querySelector('.title-strip')?.getBoundingClientRect().bottom ?? 0 };
    });
    if (top < strip || bottom > 1100) throw new Error(`${id} scene not clear of the sticky strip or viewport (top ${top}, strip ${strip}, bottom ${bottom})`);
    await scene.screenshot({ path: join(OUT, file) });
    written.push(file);
  }
  await page.locator('#methods').evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await page.locator('#methods').screenshot({ path: join(OUT, 'day-90-methods.png') });
  written.push('day-90-methods.png');
  errors.push(...errs);
  external += ext();
  await context.close();
  return external;
}

await main();
