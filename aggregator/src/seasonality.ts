// Daily bands, rolling bands, weekday and diurnal effects, ACF and trend (SPEC 4.7).
import type { RawSample } from '../../shared/types/sample.ts';
import type { MetricId, SeasonalityRollup } from '../../shared/types/rollups.ts';
import { DECIMALS, HOUR_MS, METRICS, hourOf, metricValue, round, roundOrNull, runKey, utcDate, utcMs, weekdayOf } from './common.ts';
import { uniformStream } from './prng.ts';
import { acfAt, bootstrapCI, medianPolish, quantileSorted, sortAsc, theilSen } from './stats.ts';
import { headOf, type Ctx } from './summary.ts';
import { scheduleRuns, scheduleSamples } from './drift.ts';

type Series = MetricId | 'totalDelaySec';
const SERIES: Series[] = [...METRICS, 'totalDelaySec'];
const MIN_DAILY = 20;
const MIN_ROW = 3;
const B = 1000;

interface Unit { w: number; h: number; v: number }

// Schedule events for delay (scheduledSlotIso), any event for benchmark metrics.
function valueOf(s: RawSample, m: Series): number | null {
  if (m === 'totalDelaySec') return s.event === 'schedule' ? s.timing.totalDelaySec : null;
  return metricValue(s, m);
}

function quantiles(xs: number[], d: number): { p10: number | null; p50: number | null; p90: number | null } {
  if (xs.length < MIN_DAILY) return { p10: null, p50: null, p90: null };
  const s = sortAsc(xs);
  return {
    p10: round(quantileSorted(s, 0.1), d),
    p50: round(quantileSorted(s, 0.5), d),
    p90: round(quantileSorted(s, 0.9), d),
  };
}

function cellTable(units: Unit[]): (number | null)[][] {
  const cells: number[][][] = Array.from({ length: 24 }, () => Array.from({ length: 7 }, () => []));
  for (const u of units) cells[u.h][u.w].push(u.v);
  return cells.map((row) => row.map((c) => (c.length ? medianOf(c) : null)));
}

function medianOf(xs: number[]): number {
  const s = sortAsc(xs);
  return quantileSorted(s, 0.5);
}

interface EffectRow { n: number; effect: number | null; ci95: [number, number] | null }

// Two-way polish of the hour x weekday medians. CI from B resamples of whole runs (each cluster is one run's units).
function effects(clusters: Unit[][], key: string, d: number): { weekday: EffectRow[]; diurnal: EffectRow[] } {
  const units = clusters.flat();
  const nW = new Array<number>(7).fill(0);
  const nH = new Array<number>(24).fill(0);
  for (const u of units) {
    nW[u.w]++;
    nH[u.h]++;
  }
  const base = medianPolish(cellTable(units));
  const rng = uniformStream(`season:${key}`);
  const bw: number[][] = Array.from({ length: 7 }, () => []);
  const bh: number[][] = Array.from({ length: 24 }, () => []);
  const n = clusters.length;
  if (n > 0) {
    for (let b = 0; b < B; b++) {
      const sample: Unit[] = [];
      for (let i = 0; i < n; i++) sample.push(...clusters[Math.floor(rng() * n)]);
      const p = medianPolish(cellTable(sample));
      p.colEff.forEach((v, w) => v !== null && bw[w].push(v));
      p.rowEff.forEach((v, h) => v !== null && bh[h].push(v));
    }
  }
  const row = (count: number, eff: number | null, boot: number[]): EffectRow => {
    if (count < MIN_ROW || eff === null || boot.length === 0) return { n: count, effect: null, ci95: null };
    const s = sortAsc(boot);
    return {
      n: count,
      effect: round(eff, d),
      ci95: [round(quantileSorted(s, 0.025), d), round(quantileSorted(s, 0.975), d)],
    };
  };
  return {
    weekday: nW.map((c, w) => row(c, base.colEff[w], bw[w])),
    diurnal: nH.map((c, h) => row(c, base.rowEff[h], bh[h])),
  };
}

export function buildSeasonality(ctx: Ctx): SeasonalityRollup {
  const D = ctx.days.length;
  const dayIdx = new Map(ctx.days.map((d, i) => [d, i]));

  const perDay = new Map<Series, number[][]>();
  for (const m of SERIES) perDay.set(m, Array.from({ length: D }, () => []));
  for (const s of ctx.samples) {
    const i = dayIdx.get(utcDate(s.collectedAtIso));
    if (i === undefined) continue;
    for (const m of SERIES) {
      const v = valueOf(s, m);
      if (v !== null) perDay.get(m)![i].push(v);
    }
  }

  const daily = {} as SeasonalityRollup['daily'];
  const dailyP50 = new Map<Series, (number | null)[]>();
  for (const m of SERIES) {
    const d = DECIMALS[m];
    const days = perDay.get(m)!;
    const q = days.map((xs) => quantiles(xs, d));
    dailyP50.set(m, q.map((x) => x.p50));
    const roll = (k: 'p10' | 'p50' | 'p90') =>
      days.map((_, i) => {
        if (i < 3 || i > D - 4) return null;
        const pooled = days.slice(i - 3, i + 4).flat();
        return quantiles(pooled, d)[k];
      });
    daily[m] = {
      n: days.map((xs) => xs.length),
      p10: q.map((x) => x.p10),
      p50: q.map((x) => x.p50),
      p90: q.map((x) => x.p90),
      roll7: { p10: roll('p10'), p50: roll('p50'), p90: roll('p90') },
    };
  }

  // Effects. Delay: one unit per run (schedule events). Single core: one unit per sample, row n in samples,
  // but the bootstrap resamples runs (SPEC 4.7) so jobs of one run move together.
  const runs = scheduleRuns(scheduleSamples(ctx.samples));
  const delayClusters: Unit[][] = runs.flatMap((r) => (r.total === null ? [] : [[{ w: r.weekday, h: r.hour, v: r.total }]]));
  const singleByRun = new Map<string, Unit[]>();
  for (const s of ctx.samples) {
    if (s.bench.singleCoreScore === null) continue;
    const u = { w: weekdayOf(s.collectedAtIso), h: hourOf(s.collectedAtIso), v: s.bench.singleCoreScore };
    const g = singleByRun.get(runKey(s));
    if (g) g.push(u);
    else singleByRun.set(runKey(s), [u]);
  }
  const delayFx = effects(delayClusters, 'totalDelaySec', DECIMALS.totalDelaySec);
  const singleFx = effects([...singleByRun.values()], 'singleCoreScore', DECIMALS.singleCoreScore);

  // Hourly delay series across the whole range (one slot per hour).
  const hourly: (number | null)[] = Array.from({ length: D * 24 }, () => null);
  if (D > 0) {
    const start = utcMs(`${ctx.days[0]}T00:00:00Z`);
    for (const r of runs) {
      if (r.total === null) continue;
      const idx = Math.round((utcMs(r.slot) - start) / HOUR_MS);
      if (idx >= 0 && idx < hourly.length && hourly[idx] === null) hourly[idx] = round(r.total, 1);
    }
  }
  const acfDaily = Array.from({ length: 14 }, (_, i) => acfAt(dailyP50.get('totalDelaySec')!, i + 1));
  const acfHourly = Array.from({ length: 168 }, (_, i) => acfAt(hourly, i + 1));

  const trend = {} as SeasonalityRollup['trend'];
  for (const m of SERIES) {
    const pts: Array<[number, number]> = [];
    dailyP50.get(m)!.forEach((v, i) => {
      if (v !== null) pts.push([i, v]);
    });
    if (pts.length < 14) {
      trend[m] = { theilSenPerWeek: null, ci95: null };
      continue;
    }
    const slope = (ps: Array<[number, number]>) => theilSen(ps.map((p) => p[0]), ps.map((p) => p[1]));
    const s = slope(pts);
    const ci = bootstrapCI(pts, `season:trend:${m}`, (r) => {
      const v = slope(r);
      return v === null ? null : v * 7;
    });
    const d = DECIMALS[m];
    trend[m] = {
      theilSenPerWeek: roundOrNull(s === null ? null : s * 7, d),
      ci95: ci ? [round(ci[0], d), round(ci[1], d)] : null,
    };
  }

  return {
    ...headOf('seasonality', ctx),
    days: ctx.days,
    daily,
    weekdayEffect: {
      totalDelaySec: delayFx.weekday.map((r, w) => ({ weekday: w, ...r })),
      singleCoreScore: singleFx.weekday.map((r, w) => ({ weekday: w, ...r })),
    },
    diurnalEffect: {
      totalDelaySec: delayFx.diurnal.map((r, h) => ({ hourUtc: h, ...r })),
      singleCoreScore: singleFx.diurnal.map((r, h) => ({ hourUtc: h, ...r })),
    },
    acf: { dailyTotalDelay: acfDaily, hourlyTotalDelay: acfHourly },
    trend,
  };
}
