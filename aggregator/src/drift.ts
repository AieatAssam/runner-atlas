// Schedule drift, slot ranking, terrain and headline (SPEC 4.1, 4.3). Schedule events only; the run is the unit for delay.
import type { RawSample } from '../../shared/types/sample.ts';
import type { ConfidenceTier, DriftCell, DriftRollup, Manifest, SlotScore } from '../../shared/types/rollups.ts';
import { HOUR_MS, LABELS, hourOf, round, roundOrNull, runKey, utcDate, utcDateOfMs, utcMs, weekdayOf } from './common.ts';
import { bootstrapCI, quantileSorted, sortAsc } from './stats.ts';
import { headOf, medianOf, nums, q4, ticks, type Ctx } from './summary.ts';

export interface RunRec {
  key: string;
  slot: string;
  weekday: number;
  hour: number;
  samples: number;
  drift: number | null;
  queue: number | null;
  total: number | null;
}

export interface Coverage {
  expected: number;
  observed: number;
  missedByHour: number[];
  expectedByDate: Map<string, number>;
  observedByDate: Map<string, number>;
}

export function scheduleSamples(samples: RawSample[]): RawSample[] {
  return samples.filter((s) => s.event === 'schedule' && s.timing.scheduledSlotIso !== null);
}

export function scheduleRuns(schedule: RawSample[]): RunRec[] {
  const groups = new Map<string, RawSample[]>();
  for (const s of schedule) {
    const k = runKey(s);
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  const runs: RunRec[] = [];
  for (const [key, g] of groups) {
    const slot = g.map((s) => s.timing.scheduledSlotIso as string).sort()[0];
    runs.push({
      key,
      slot,
      weekday: weekdayOf(slot),
      hour: hourOf(slot),
      samples: g.length,
      drift: medianOf(g.map((s) => s.timing.cronDriftSec)),
      queue: medianOf(g.map((s) => s.timing.queueTimeSec)),
      total: medianOf(g.map((s) => s.timing.totalDelaySec)),
    });
  }
  return runs;
}

// Expected slots run from the first to the last observed scheduled slot, inclusive, hourly.
export function slotCoverage(schedule: RawSample[]): Coverage {
  const observedSet = new Set(schedule.map((s) => s.timing.scheduledSlotIso as string));
  const observedByHour = new Array<number>(24).fill(0);
  const expectedByHour = new Array<number>(24).fill(0);
  const observedByDate = new Map<string, number>();
  const expectedByDate = new Map<string, number>();
  for (const slot of observedSet) {
    observedByHour[hourOf(slot)]++;
    const d = utcDate(slot);
    observedByDate.set(d, (observedByDate.get(d) ?? 0) + 1);
  }
  let expected = 0;
  if (observedSet.size > 0) {
    const ms = [...observedSet].map(utcMs);
    const end = Math.max(...ms);
    for (let t = Math.min(...ms); t <= end; t += HOUR_MS) {
      expected++;
      expectedByHour[new Date(t).getUTCHours()]++;
      const d = utcDateOfMs(t);
      expectedByDate.set(d, (expectedByDate.get(d) ?? 0) + 1);
    }
  }
  return {
    expected,
    observed: observedSet.size,
    missedByHour: expectedByHour.map((e, h) => Math.max(0, e - observedByHour[h])),
    expectedByDate,
    observedByDate,
  };
}

// SPEC 4.3: S = median + 0.5 * (p90 - median) over run delays.
const scoreOf = (xs: number[]): number => {
  const s = sortAsc(xs);
  const m = quantileSorted(s, 0.5);
  const p = quantileSorted(s, 0.9);
  return m + 0.5 * (p - m);
};

interface Built {
  cell: DriftCell;
  score: number | null;
  ci: [number, number] | null;
  med: number | null;
  p90: number | null;
  index: number;
}

function buildCell(runs: RunRec[], weekday: number | null, hourUtc: number, key: string, samples: number, index: number): Built {
  const drift = nums(runs.map((r) => r.drift));
  const queue = nums(runs.map((r) => r.queue));
  const total = nums(runs.map((r) => r.total));
  let score: number | null = null;
  let ci: [number, number] | null = null;
  let med: number | null = null;
  let p90: number | null = null;
  if (runs.length >= 3 && total.length >= 3) {
    const s = sortAsc(total);
    med = quantileSorted(s, 0.5);
    p90 = quantileSorted(s, 0.9);
    score = scoreOf(total);
    ci = bootstrapCI(total, key, scoreOf);
  }
  const cell: DriftCell = {
    weekday,
    hourUtc,
    runs: runs.length,
    samples,
    drift: drift.length ? q4(drift, 1) : null,
    queue: queue.length ? q4(queue, 1) : null,
    total: total.length ? q4(total, 1) : null,
    score: roundOrNull(score, 2),
    ci95: ci ? [round(ci[0], 2), round(ci[1], 2)] : null,
  };
  return { cell, score, ci, med, p90, index };
}

export function buildDrift(ctx: Ctx): DriftRollup {
  const schedule = scheduleSamples(ctx.samples);
  const runs = scheduleRuns(schedule);

  const byCell = new Map<number, RunRec[]>();
  const byHourRuns: RunRec[][] = Array.from({ length: 24 }, () => []);
  const samplesCell = new Array<number>(168).fill(0);
  const samplesHour = new Array<number>(24).fill(0);
  for (const r of runs) {
    const idx = r.weekday * 24 + r.hour;
    const g = byCell.get(idx);
    if (g) g.push(r);
    else byCell.set(idx, [r]);
    byHourRuns[r.hour].push(r);
    samplesCell[idx] += r.samples;
    samplesHour[r.hour] += r.samples;
  }

  const wh: Built[] = [];
  for (let w = 0; w < 7; w++) {
    for (let h = 0; h < 24; h++) {
      const idx = w * 24 + h;
      wh.push(buildCell(byCell.get(idx) ?? [], w, h, `drift:${w}:${h}`, samplesCell[idx], idx));
    }
  }
  const hourBuilt: Built[] = byHourRuns.map((rs, h) => buildCell(rs, null, h, `drift:-:${h}`, samplesHour[h], h));

  // SPEC 4.3 granularity: weekday-hour when >= 70% of 168 cells are eligible.
  const whEligible = wh.filter((b) => b.score !== null).length;
  const granularity: DriftRollup['ranking']['granularity'] =
    whEligible >= Math.ceil(0.7 * 168) ? 'weekday-hour' : hourBuilt.some((b) => b.score !== null) ? 'hour' : null;
  const pool = granularity === 'weekday-hour' ? wh : granularity === 'hour' ? hourBuilt : [];
  type Eligible = Built & { score: number; ci: [number, number]; med: number; p90: number };
  const elig = pool.filter(
    (b): b is Eligible => b.score !== null && b.ci !== null && b.med !== null && b.p90 !== null,
  );
  const sortedBest = [...elig].sort((a, b) => a.score - b.score || a.p90 - b.p90 || a.index - b.index);
  const sortedWorst = [...elig].sort((a, b) => b.score - a.score || b.p90 - a.p90 || a.index - b.index);
  const toSlot = (b: Eligible): SlotScore => ({
    weekday: b.cell.weekday,
    hourUtc: b.cell.hourUtc,
    runs: b.cell.runs,
    samples: b.cell.samples,
    medianSec: round(b.med, 1),
    p90Sec: round(b.p90, 1),
    score: round(b.score, 2),
    ci95: [round(b.ci[0], 2), round(b.ci[1], 2)],
  });

  const medians = wh.filter((b) => b.cell.total !== null).map((b) => b.cell.total!.median);
  const tMin = medians.length >= 2 ? Math.min(...medians) : null;
  const tMax = medians.length >= 2 ? Math.max(...medians) : null;
  const contours =
    tMin !== null && tMax !== null && tMin < tMax
      ? ticks(tMin, tMax, 6).filter((t) => t > tMin && t < tMax).map((t) => round(t, 1))
      : [];

  const byLabel = LABELS.map((label) => {
    const ls = schedule.filter((s) => s.label === label);
    return {
      label,
      byHour: Array.from({ length: 24 }, (_, h) => {
        const inH = ls.filter((s) => hourOf(s.timing.scheduledSlotIso as string) === h);
        const queue = nums(inH.map((s) => s.timing.queueTimeSec));
        return {
          hourUtc: h,
          runs: new Set(inH.map(runKey)).size,
          queue: queue.length ? q4(queue, 1) : null,
        };
      }),
    };
  });

  const cov = slotCoverageOf(schedule);
  return {
    ...headOf('drift', ctx),
    weekdayHour: wh.map((b) => b.cell),
    byHour: hourBuilt.map((b) => b.cell),
    byLabel,
    ranking: {
      granularity,
      best: sortedBest.slice(0, 5).map(toSlot),
      worst: sortedWorst.slice(0, 5).map(toSlot),
    },
    slots: { expected: cov.expected, observed: cov.observed, missedByHour: cov.missedByHour },
    terrain: { min: tMin === null ? null : round(tMin, 1), max: tMax === null ? null : round(tMax, 1), contours },
  };
}

function slotCoverageOf(schedule: RawSample[]): Coverage {
  return slotCoverage(schedule);
}

// Headline and tier (SPEC 4.3). Best and worst are null when the tier is insufficient.
export function headlineFor(ctx: Ctx, drift: DriftRollup, surveyDay: number): Manifest['headline'] {
  const n = ctx.samples.length;
  const coverage = drift.slots.expected > 0 ? drift.slots.observed / drift.slots.expected : null;
  const granularity = drift.ranking.granularity;
  const best = drift.ranking.best[0] ?? null;
  const worst = drift.ranking.worst[0] ?? null;
  let reason: string | null = null;
  if (n === 0) reason = 'no samples yet';
  else if (surveyDay < 3) reason = 'fewer than 3 survey days';
  else if (n < 150) reason = 'fewer than 150 samples';
  else if (!best || !worst) reason = 'no slot has 3 runs yet';
  if (reason !== null || !best || !worst) {
    return { tier: 'insufficient', granularity, best: null, worst: null, separated: null, reason: reason ?? 'no slot has 3 runs yet' };
  }
  const separated = best.ci95[1] < worst.ci95[0];
  const base: ConfidenceTier =
    surveyDay >= 90
      ? coverage !== null && coverage >= 0.8 ? 'high' : 'established'
      : surveyDay >= 30 ? 'established' : surveyDay >= 7 ? 'emerging' : 'preliminary';
  const order: ConfidenceTier[] = ['preliminary', 'emerging', 'established', 'high'];
  const tier = separated ? base : order[Math.max(0, order.indexOf(base) - 1)];
  return { tier, granularity, best, worst, separated, reason: null };
}
