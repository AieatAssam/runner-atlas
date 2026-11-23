// The 2D chart modules render from real rollups built by the aggregator: an empty day, one day and ninety days.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Built } from '../../aggregator/src/rollup.ts';
import type { ChartModule, ChartTokens, RenderContext } from '../../site/src/types/views.ts';
import beeswarm from '../../site/src/charts/beeswarm.ts';
import changepoints from '../../site/src/charts/changepoints.ts';
import driftHeatmap from '../../site/src/charts/drift-heatmap.ts';
import fleetSankey from '../../site/src/charts/fleet-sankey.ts';
import fleetTable from '../../site/src/charts/fleet-table.ts';
import neighboursMultiples from '../../site/src/charts/neighbours-multiples.ts';
import neighboursScatter from '../../site/src/charts/neighbours-scatter.ts';
import pointcloud2d from '../../site/src/charts/pointcloud-2d.ts';
import recentSamples from '../../site/src/charts/recent-samples.ts';
import regionMap from '../../site/src/charts/region-map.ts';
import ridgelines from '../../site/src/charts/ridgelines.ts';
import rolloutTimeline from '../../site/src/charts/rollout-timeline.ts';
import seasonalityBands from '../../site/src/charts/seasonality-bands.ts';
import seasonalityEffects from '../../site/src/charts/seasonality-effects.ts';
import slotRanking from '../../site/src/charts/slot-ranking.ts';

const TOKENS: ChartTokens = {
  paper: '#fbfaf6', paper2: '#f1efe8', ink: '#1d1d1b', ink2: '#3b3b37', muted: '#6b6a63', rule: '#d9d6cc',
  accent: '#b4532a', focus: '#1f5fa8', warn: '#a33d2e',
  series: ['#2f6f73', '#b4532a', '#6b5b95', '#8a7a2c', '#3f7d4f', '#9a4f74'],
  sequential: ['#f3efe2', '#e6d9b2', '#d4b970', '#bd9a48', '#9b7530', '#6e5020', '#41300f'],
  diverging: { low: '#2f6f73', mid: '#f1efe8', high: '#b4532a' },
  fontBody: 'serif', fontFigure: 'monospace',
};

interface Case { name: string; mod: ChartModule<never>; pick: (b: Built) => unknown }

const CASES: Case[] = [
  { name: 'region-map', mod: regionMap as ChartModule<never>, pick: (b) => b.values.regions },
  { name: 'fleet-sankey', mod: fleetSankey as ChartModule<never>, pick: (b) => b.values.fleet },
  { name: 'fleet-table', mod: fleetTable as ChartModule<never>, pick: (b) => b.values.fleet },
  { name: 'recent-samples', mod: recentSamples as ChartModule<never>, pick: (b) => b.values.fleet },
  { name: 'ridgelines', mod: ridgelines as ChartModule<never>, pick: (b) => b.values.benchmarks },
  { name: 'beeswarm', mod: beeswarm as ChartModule<never>, pick: (b) => b.values.benchmarks },
  { name: 'pointcloud-2d', mod: pointcloud2d as ChartModule<never>, pick: (b) => b.values.benchmarks },
  { name: 'drift-heatmap', mod: driftHeatmap as ChartModule<never>, pick: (b) => b.values.drift },
  { name: 'slot-ranking', mod: slotRanking as ChartModule<never>, pick: (b) => b.values.drift },
  { name: 'neighbours-scatter', mod: neighboursScatter as ChartModule<never>, pick: (b) => b.values.neighbours },
  { name: 'neighbours-multiples', mod: neighboursMultiples as ChartModule<never>, pick: (b) => b.values.neighbours },
  { name: 'rollout-timeline', mod: rolloutTimeline as ChartModule<never>, pick: (b) => b.values.rollouts },
  { name: 'changepoints', mod: changepoints as ChartModule<never>, pick: (b) => b.values.rollouts },
  { name: 'seasonality-bands', mod: seasonalityBands as ChartModule<never>, pick: (b) => b.values.seasonality },
  { name: 'seasonality-effects', mod: seasonalityEffects as ChartModule<never>, pick: (b) => b.values.seasonality },
];

const DAYS = ['day0', 'day1', 'day90'] as const;
type Day = typeof DAYS[number];

function ctxFor(root: HTMLElement, signal = new AbortController().signal, width = 640): RenderContext {
  return { root, tokens: TOKENS, reducedMotion: false, signal, width, announce: () => {} };
}

let built: Record<Day, Built>;
let closeWindow: (() => Promise<void>) | null = null;

beforeAll(async () => {
  // The aggregator reads its schema folder with import.meta.url under Node's URL, which a happy-dom
  // environment replaces. So this file runs in Node and installs a happy-dom window after loading it.
  const { loadCoords } = await import('../../aggregator/src/cli.ts');
  const { buildRollups } = await import('../../aggregator/src/rollup.ts');
  const { generate } = await import('../../scripts/synthetic/generate.ts');
  const { Window } = await import('happy-dom');
  const win = new Window();
  Object.assign(globalThis, { window: win, document: win.document });
  closeWindow = async () => {
    await win.happyDOM.close();
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
  };
  const coords = loadCoords();
  const samples = (days: number) => generate({ days, seed: 7, start: '2026-01-05' });
  built = {
    day0: buildRollups([], coords),
    day1: buildRollups(samples(1), coords),
    day90: buildRollups(samples(90), coords),
  };
}, 120_000);

// Vitest isolates each test file, so these globals never reach other files; removing them here also stops pending timers.
afterAll(async () => {
  await closeWindow?.();
});

describe('chart modules', () => {
  it('has exactly the 15 panel modules plus the shared _axis helper', () => {
    const files = readdirSync(fileURLToPath(new URL('../../site/src/charts', import.meta.url))).sort();
    const expected = [...CASES.map((c) => `${c.name}.ts`), '_axis.ts'].sort();
    expect(files).toEqual(expected);
  });

  for (const c of CASES) {
    for (const day of DAYS) {
      it(`${c.name} renders the ${day} rollups with a caption`, () => {
        const root = document.createElement('div');
        document.body.append(root);
        const data = c.pick(built[day]) as never;
        expect(() => c.mod.render(ctxFor(root), data)).not.toThrow();
        expect(root.children.length).toBeGreaterThan(0);
        if (day === 'day90') expect(root.querySelector('svg, table')).not.toBeNull();
        // Every chart block with data marks is one tab stop, and every mark names itself and its n.
        for (const wrap of root.querySelectorAll('.chart')) {
          const marks = wrap.querySelectorAll('[data-tip]');
          if (marks.length === 0) continue;
          expect(wrap.querySelectorAll('[data-tip][tabindex="0"]').length).toBe(1);
          expect(wrap.querySelectorAll('[data-tip] [data-tip]').length).toBe(0);
          for (const mark of marks) {
            expect(mark.getAttribute('aria-label')).toBeTruthy();
            // Exempt: ACF lags and rollout day bars, whose rollups carry no per-lag or per-day count.
            const tip = mark.getAttribute('data-tip') ?? '';
            const exempt = tip.startsWith('Lag ') || (c.name === 'rollout-timeline' && /^\d{4}-\d{2}-\d{2},/.test(tip));
            if (!exempt) expect(tip).toContain('n = ');
          }
        }
        if (day === 'day90' && !['fleet-table', 'recent-samples', 'changepoints'].includes(c.name)) {
          expect(root.querySelectorAll('[data-tip]').length).toBeGreaterThan(0);
        }
        const cap = c.mod.caption(data);
        expect(typeof cap.n).toBe('number');
        expect(['samples', 'runs']).toContain(cap.unit);
        root.remove();
      });
    }
  }

  it('region-map renders twice on one page without duplicate ids', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    document.body.append(a, b);
    const regions = built.day90.values.regions as never;
    regionMap.render(ctxFor(a), regions);
    regionMap.render(ctxFor(b), regions);
    expect(a.querySelectorAll('[id]').length).toBe(0);
    expect(b.querySelectorAll('[id]').length).toBe(0);
    a.remove();
    b.remove();
  });

  it('shows the tooltip at once on focus, walks marks with arrow keys, and goes quiet after abort', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new AbortController();
    driftHeatmap.render(ctxFor(root, controller.signal), built.day90.values.drift as never);
    const tip = root.querySelector<HTMLElement>('.chart__tip');
    const first = root.querySelector<SVGElement>('[data-tip][tabindex="0"]');
    expect(tip?.hidden).toBe(true);
    first?.focus();
    expect(tip?.hidden).toBe(false);
    expect(tip?.textContent).toBe(first?.getAttribute('data-tip'));
    first?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }) as unknown as Event);
    const second = root.querySelectorAll('[data-tip]')[1];
    expect(document.activeElement).toBe(second);
    expect(second?.getAttribute('tabindex')).toBe('0');
    expect(first?.getAttribute('tabindex')).toBe('-1');
    expect(tip?.textContent).toBe(second?.getAttribute('data-tip'));
    controller.abort();
    expect(tip?.hidden).toBe(true);
    first?.focus();
    expect(tip?.hidden).toBe(true);
    root.remove();
  });

  it('rollout-timeline draws one horizontal bar per day, at most 24 px thick', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const rollouts = built.day90.values.rollouts as never as { days: string[]; byLabel: unknown[] };
    rolloutTimeline.render(ctxFor(root), rollouts as never);
    const days = [...root.querySelectorAll('rect[data-tip]')].filter((r) => /^\d{4}-\d{2}-\d{2},/.test(r.getAttribute('data-tip') ?? ''));
    expect(days.length).toBe(rollouts.days.length * rollouts.byLabel.length);
    for (const r of days) {
      const w = Number(r.getAttribute('width'));
      const h = Number(r.getAttribute('height'));
      expect(w).toBeGreaterThan(h);
      expect(h).toBeLessThanOrEqual(24);
    }
    root.remove();
  });

  it('counts the point cloud fallback in samples', () => {
    expect(pointcloud2d.caption(built.day90.values.benchmarks as never).unit).toBe('samples');
  });

  it('colours series by runner label, not by row order', () => {
    const root = document.createElement('div');
    document.body.append(root);
    ridgelines.render(ctxFor(root), built.day90.values.benchmarks as never);
    const fills = [...root.querySelectorAll('path[fill-opacity]')].map((p) => p.getAttribute('fill'));
    expect(fills).toContain(TOKENS.series[3]);
    const macos = [...root.querySelectorAll('[data-tip]')].find((m) => m.getAttribute('data-tip')?.startsWith('macos-15,'));
    expect(macos?.querySelector('path[fill-opacity]')?.getAttribute('fill')).toBe(TOKENS.series[3]);
    root.remove();
  });
});
