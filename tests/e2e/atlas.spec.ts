// SPEC 8 end-to-end checks. One file runs against both projects: `day-0` (empty rollups, standby)
// and `day-90` (synthetic rollups, every tier open). Day-90-only checks say so and skip on day-0.
import { test, expect, chromium, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { announcerText, collectErrors, expectNoErrors, panelStates, settleAll } from './support.ts';

const DAY_90 = 'day-90';
const WIDTHS = [320, 375, 768, 1280, 1440, 1920] as const;
const GL_ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'];
const SCENES = ['globe', 'pointcloud', 'terrain'] as const;

test.setTimeout(180_000);

const isDay90 = (project: string): boolean => project === DAY_90;

async function themeAttr(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset.theme);
}

test.describe('first viewport (1280 x 800)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('headline, sentence, answer, primary action, Methods link, title block and region map fit the fold', async ({ page }) => {
    await page.goto('/');
    const targets = {
      'headline': '#hero-title',
      'sentence': '.hero__sentence',
      'answer block': '.answer',
      'primary action': '.hero__actions a.button',
      'Methods link': '.hero__actions a[href="#methods"]',
      'title block': '.title-block__dl',
      'region-map well': 'section.panel[data-panel="region-map"]',
    };
    for (const [name, selector] of Object.entries(targets)) {
      const box = await page.locator(selector).boundingBox();
      expect(box, `${name} is rendered`).not.toBeNull();
      expect(box!.y, `${name} starts inside the fold`).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height, `${name} ends inside the fold`).toBeLessThanOrEqual(800);
    }
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
});

// Elements whose box runs past the right edge of the viewport, outside any scroll or clip container of their own.
// html and body clip horizontal overflow, so scrollWidth alone would never see it; this looks at the boxes.
function overflowing(): string[] {
  const vw = document.documentElement.clientWidth;
  const out: string[] = [];
  for (const node of document.body.querySelectorAll<Element>('*')) {
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.right <= vw + 1) continue;
    let contained = false;
    for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).overflowX !== 'visible') { contained = true; break; }
    }
    if (!contained) out.push(`${node.tagName.toLowerCase()}${node.id ? '#' + node.id : ''}.${[...node.classList].join('.')} right=${Math.round(r.right)}`);
  }
  return out;
}

test.describe('layout', () => {
  test('no horizontal overflow at 320, 375, 768, 1280, 1440 and 1920 px', async ({ page }) => {
    await page.goto('/');
    await settleAll(page);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(scroll, `scrollable overflow at ${width} px`).toBe(0);
      const boxes = await page.evaluate(overflowing);
      expect(boxes, `boxes past the right edge at ${width} px`).toEqual([]);
    }
    // Control: the detector does see a box that runs off the page.
    await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.width = '2000px';
      probe.style.height = '10px';
      document.querySelector('main')?.append(probe);
    });
    expect((await page.evaluate(overflowing)).length, 'control: a 2000 px box is detected').toBeGreaterThan(0);
  });
});

test.describe('network', () => {
  test('no request leaves localhost on a full load', async ({ page, baseURL }) => {
    const origin = new URL(baseURL ?? 'http://127.0.0.1/').origin;
    const external: string[] = [];
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      external.push(url);
      return route.abort();
    });
    await page.goto('/');
    await settleAll(page);
    expect(external, external.join('\n')).toEqual([]);
  });
});

test.describe('without JavaScript', () => {
  test('hero, title block and Methods render', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(baseURL ?? '/');
    await expect(page.locator('#hero-title')).toBeVisible();
    await expect(page.locator('.hero__sentence')).toBeVisible();
    await expect(page.locator('.answer')).toBeVisible();
    await expect(page.locator('.title-block__dl')).toBeVisible();
    await expect(page.locator('#methods')).toBeVisible();
    await context.close();
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('transitions are zeroed and no CSS animation runs', async ({ page, browser, baseURL }) => {
    const duration = (p: typeof page) => p.locator('a').first().evaluate((el) => getComputedStyle(el).transitionDuration);
    await page.goto('/');
    await settleAll(page);
    expect(await duration(page)).toBe('0s');
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
    expect(running).toBe(0);
    // Control: without the preference the same link keeps its transition, so the check above is not vacuous.
    const context = await browser.newContext({ baseURL, reducedMotion: 'no-preference' });
    const plain = await context.newPage();
    await plain.goto('/');
    expect(await duration(plain)).not.toBe('0s');
    await context.close();
  });

  test('the globe does not spin (day-90)', async ({ page, browser, baseURL }, testInfo) => {
    test.skip(!isDay90(testInfo.project.name), 'Day-90 only: the globe is in the fleet sheet');
    await page.goto('/');
    await settleAll(page);
    const globe = page.locator('section[data-panel="globe"] .scene canvas');
    await globe.scrollIntoViewIfNeeded();
    const first = await globe.screenshot();
    await page.waitForTimeout(1500);
    const second = await globe.screenshot();
    expect(first.equals(second), 'reduced motion: consecutive globe frames are identical').toBe(true);

    // Control: the same globe with motion allowed must change between frames.
    const context = await browser.newContext({ reducedMotion: 'no-preference' });
    const moving = await context.newPage();
    await moving.goto(baseURL ?? '/');
    await settleAll(moving);
    const canvas = moving.locator('section[data-panel="globe"] .scene canvas');
    await canvas.scrollIntoViewIfNeeded();
    const a = await canvas.screenshot();
    await moving.waitForTimeout(1500);
    const b = await canvas.screenshot();
    await context.close();
    expect(a.equals(b), 'control: globe rotates when motion is allowed').toBe(false);
  });
});

test.describe('without WebGL (day-90)', () => {
  test('all three scenes fall back to 2D and each fallback is announced', async ({ baseURL }, testInfo) => {
    test.skip(!isDay90(testInfo.project.name), 'Day-90 only: scenes need synthetic tiers');
    const browser = await chromium.launch({ args: ['--disable-webgl'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // The live region is overwritten by each message, so every write is recorded as it happens.
    await context.addInitScript(() => {
      const log: string[] = [];
      (window as unknown as { __announced: string[] }).__announced = log;
      document.addEventListener('DOMContentLoaded', () => {
        const region = document.getElementById('announcer');
        if (!region) return;
        new MutationObserver(() => { const text = region.textContent?.trim(); if (text) log.push(text); })
          .observe(region, { childList: true, characterData: true, subtree: true });
      });
    });
    const page = await context.newPage();
    const errors = collectErrors(page);
    await page.goto(baseURL ?? '/');
    await settleAll(page);
    await expect(page.locator('.scene canvas')).toHaveCount(0);
    for (const id of SCENES) {
      await expect(page.locator(`section[data-panel="${id}"] .chart svg`).first(), `${id} shows its 2D fallback`).toBeVisible();
      const title = (await page.locator(`section[data-panel="${id}"] .panel__title`).textContent())?.trim() ?? id;
      await expect.poll(() => page.evaluate(() => (window as unknown as { __announced: string[] }).__announced), { message: `${id} fallback is announced` })
        .toContainEqual(expect.stringContaining(`${title} shows its 2D chart because`));
    }
    expectNoErrors(errors);
    await browser.close();
  });
});

test.describe('keyboard', () => {
  test('Tab reaches each 3D scene and arrow keys change the announcement (day-90)', async ({ page }, testInfo) => {
    test.skip(!isDay90(testInfo.project.name), 'Day-90 only: scenes need synthetic tiers');
    await page.goto('/');
    await settleAll(page);
    await page.locator('#hero-title').focus();
    for (const id of SCENES) {
      let reached = false;
      for (let i = 0; i < 400 && !reached; i++) {
        await page.keyboard.press('Tab');
        reached = await page.evaluate((name) => {
          const active = document.activeElement;
          return !!active && active.classList.contains('scene') && !!active.closest(`section[data-panel="${name}"]`);
        }, id);
      }
      expect(reached, `Tab reaches the ${id} scene`).toBe(true);
      const before = await announcerText(page);
      await page.keyboard.press('ArrowRight');
      // The shell clears the live region, then writes the new message 50 ms later, so wait for a non-empty change.
      await expect.poll(() => announcerText(page), { message: `ArrowRight announces on ${id}` }).toMatch(/.{11,}/);
      expect(await announcerText(page)).not.toBe(before);
    }
  });
});

test.describe('accessibility', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`axe-core reports no violations in ${theme} theme`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ colorScheme: theme });
      await context.addInitScript((t) => window.localStorage.setItem('atlas-theme', t), theme);
      const page = await context.newPage();
      await page.goto(baseURL ?? '/');
      await settleAll(page);
      expect(await themeAttr(page), `the ${theme} theme is applied`).toBe(theme);
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`)).toEqual([]);
      await context.close();
    });
  }
});

test.describe('state', () => {
  test('every open panel reaches full (day-90)', async ({ page }, testInfo) => {
    test.skip(!isDay90(testInfo.project.name), 'Day-90 only: every tier is open');
    await page.goto('/');
    await settleAll(page);
    const states = await panelStates(page);
    expect(Object.keys(states)).toHaveLength(17);
    expect(Object.entries(states).filter(([, s]) => s !== 'full')).toEqual([]);
  });

  test('synthetic banner is shown on day-90 and absent on day-0', async ({ page }, testInfo) => {
    await page.goto('/');
    if (isDay90(testInfo.project.name)) await expect(page.locator('#synthetic-banner')).toBeVisible();
    else await expect(page.locator('#synthetic-banner')).toBeHidden();
  });

  test('day-0 shows the standby state; day-90 shows the survey sheets', async ({ page }, testInfo) => {
    await page.goto('/');
    if (isDay90(testInfo.project.name)) {
      await expect(page.locator('#sheets')).toBeVisible();
      await expect(page.locator('#standby')).toBeHidden();
    } else {
      await expect(page.locator('#standby')).toBeVisible();
      await expect(page.locator('#answer-lead')).toContainText('Awaiting first sweep');
      await expect(page.locator('#sheets')).toBeHidden();
    }
  });

  test('the theme choice survives a reload', async ({ page }) => {
    await page.goto('/');
    const before = await themeAttr(page);
    await page.locator('#theme-switch').click();
    const chosen = await themeAttr(page);
    expect(chosen).not.toBe(before);
    await page.reload();
    expect(await themeAttr(page)).toBe(chosen);
  });
});
