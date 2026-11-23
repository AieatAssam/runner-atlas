import { expect, type Page } from '@playwright/test';

// Scrolls the whole page, then brings every panel still loading into view one at a time until none is loading.
// A fast scroll can skip a lazy trigger (SPEC 6.6), so each loading panel gets its own scroll and wait.
export async function settleAll(page: Page): Promise<void> {
  const height = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y <= height; y += 500) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(80);
  }
  const loading = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('section.panel[data-panel]')].filter((s) => s.dataset.state === 'loading').map((s) => s.dataset.panel ?? ''));
  for (const id of loading) {
    await page.locator(`section.panel[data-panel="${id}"]`).scrollIntoViewIfNeeded();
    await page.waitForFunction(
      (name) => document.querySelector<HTMLElement>(`section.panel[data-panel="${name}"]`)?.dataset.state !== 'loading',
      id,
      { timeout: 60_000 },
    );
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.fonts.ready);
}

export async function panelStates(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll<HTMLElement>('section.panel[data-panel]')].map((s) => [s.dataset.panel ?? '', s.dataset.state ?? ''])));
}

export async function announcerText(page: Page): Promise<string> {
  return (await page.locator('#announcer').textContent()) ?? '';
}

// Collects uncaught page errors and console errors; the spec fails on any.
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  return errors;
}

export function expectNoErrors(errors: string[]): void {
  expect(errors, errors.join('\n')).toEqual([]);
}
