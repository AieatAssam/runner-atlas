// Shared rollup scaffolding: context, heads, quantile summaries, d3-style ticks.
import type { RawSample } from '../../shared/types/sample.ts';
import type { DateRange, Head, Q4, Q5 } from '../../shared/types/rollups.ts';
import { allDays, round, runKey, utcDate } from './common.ts';
import { quantileSorted, sortAsc } from './stats.ts';

export interface Ctx {
  samples: RawSample[]; // sorted by sortSamples
  range: DateRange | null;
  days: string[]; // every UTC date in range, gaps included; [] when empty
}

export function makeCtx(sorted: RawSample[]): Ctx {
  if (sorted.length === 0) return { samples: sorted, range: null, days: [] };
  const from = utcDate(sorted[0].collectedAtIso);
  const to = utcDate(sorted[sorted.length - 1].collectedAtIso);
  return { samples: sorted, range: { from, to }, days: allDays(from, to) };
}

export function countRuns(samples: RawSample[]): number {
  return new Set(samples.map(runKey)).size;
}

export function headOf(name: string, ctx: Ctx): Head {
  return {
    schema: `runner-atlas/${name}@1`,
    range: ctx.range,
    n: { samples: ctx.samples.length, runs: countRuns(ctx.samples) },
  };
}

export function nums(xs: Array<number | null>): number[] {
  return xs.filter((x): x is number => x !== null);
}

export function medianOf(xs: Array<number | null>): number | null {
  const v = nums(xs);
  if (v.length === 0) return null;
  const s = sortAsc(v);
  return quantileSorted(s, 0.5);
}

export function q5(xs: number[], d: number): Q5 {
  if (xs.length === 0) throw new Error('q5 of empty array');
  const s = sortAsc(xs);
  const at = (p: number) => round(quantileSorted(s, p), d);
  return { p10: at(0.1), p25: at(0.25), p50: at(0.5), p75: at(0.75), p90: at(0.9) };
}

export function q4(xs: number[], d: number): Q4 {
  if (xs.length === 0) throw new Error('q4 of empty array');
  const s = sortAsc(xs);
  const at = (p: number) => round(quantileSorted(s, p), d);
  return { median: at(0.5), p25: at(0.25), p75: at(0.75), p95: at(0.95) };
}

// Most common non-null string; ties broken by lexicographic order. null when none.
export function mostCommon(xs: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const x of xs) if (x !== null) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: string | null = null;
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN || (n === bestN && best !== null && k < best)) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

// [key, n] pairs sorted by n desc, then key asc.
export function countsSorted(xs: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// d3-array ticks(start, stop, count) for start < stop, positive step only.
export function ticks(start: number, stop: number, count: number): number[] {
  const step0 = Math.abs(stop - start) / Math.max(0, count);
  if (!(step0 > 0) || !Number.isFinite(step0)) return [];
  const step1 = 10 ** Math.floor(Math.log10(step0));
  const error = step0 / step1;
  const mult = error >= Math.sqrt(50) ? 10 : error >= Math.sqrt(10) ? 5 : error >= Math.sqrt(2) ? 2 : 1;
  const step = step1 * mult;
  const lo = Math.min(start, stop);
  const hi = Math.max(start, stop);
  const out: number[] = [];
  for (let i = Math.ceil(lo / step); i <= Math.floor(hi / step); i++) out.push(round(i * step, 10));
  return out;
}
