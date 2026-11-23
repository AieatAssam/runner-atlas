// Shared helpers for the aggregator. Pure: no wall clock, no randomness.
import type { RawSample, RunnerLabel } from '../../shared/types/sample.ts';
import type { MetricId } from '../../shared/types/rollups.ts';

export const LABELS: readonly RunnerLabel[] = [
  'ubuntu-24.04', 'ubuntu-24.04-arm', 'windows-2025', 'windows-11-arm', 'macos-15', 'macos-15-intel',
];
export const LINUX_LABELS: readonly RunnerLabel[] = ['ubuntu-24.04', 'ubuntu-24.04-arm'];
export const METRICS: readonly MetricId[] = [
  'singleCoreScore', 'multiCoreScore', 'seqWriteMBs', 'seqReadMBs', 'memBandwidthGBs', 'netTtfbMs', 'netMbps',
];
// Decimals from SPEC 1: seconds 1, scores 2, MB/s 1, GB/s 2, percentages 2, correlations 3, densities 3.
export const DECIMALS: Record<MetricId | 'totalDelaySec', number> = {
  singleCoreScore: 2, multiCoreScore: 2, seqWriteMBs: 1, seqReadMBs: 1, memBandwidthGBs: 2,
  netTtfbMs: 1, netMbps: 1, totalDelaySec: 1,
};

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export function utcMs(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid timestamp: ${iso}`);
  return t;
}

export function utcDateOfMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function utcDate(iso: string): string {
  return utcDateOfMs(utcMs(iso));
}

export function addDays(date: string, n: number): string {
  return utcDateOfMs(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS);
}

// Every UTC date from `from` to `to` inclusive (gap days included).
export function allDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function hourOf(iso: string): number {
  return new Date(utcMs(iso)).getUTCHours();
}

// ISO weekday - 1: 0 = Monday ... 6 = Sunday (UTC).
export function weekdayOf(iso: string): number {
  return (new Date(utcMs(iso)).getUTCDay() + 6) % 7;
}

export function cmp<T extends string | number>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Round half away from float noise; never returns -0; throws on NaN/Infinity so bad maths cannot ship.
export function round(x: number, decimals: number): number {
  if (!Number.isFinite(x)) throw new Error(`non-finite number in rollup: ${x}`);
  const f = 10 ** decimals;
  const v = Math.round(x * f) / f;
  return v === 0 ? 0 : v;
}

export function roundOrNull(x: number | null, decimals: number): number | null {
  return x === null ? null : round(x, decimals);
}

// Run identity: all jobs of one workflow run share runCreatedAtIso. Local samples have none, so they stand alone.
export function runKey(s: RawSample): string {
  return s.timing.runCreatedAtIso ?? `id:${s.id}`;
}

// Stable order: time, then id. Every rollup receives samples sorted this way.
export function sortSamples(samples: RawSample[]): RawSample[] {
  return [...samples].sort((a, b) => utcMs(a.collectedAtIso) - utcMs(b.collectedAtIso) || cmp(a.id, b.id));
}

// Value of a benchmark metric for one sample, or null when it does not count for that metric.
export function metricValue(s: RawSample, metric: MetricId | 'totalDelaySec'): number | null {
  switch (metric) {
    case 'singleCoreScore': return s.bench.singleCoreScore;
    case 'multiCoreScore': return s.bench.multiCoreScore;
    case 'seqWriteMBs': return s.bench.seqWriteMBs;
    case 'seqReadMBs': return s.bench.seqReadMBs;
    case 'memBandwidthGBs': return s.bench.memBandwidthGBs;
    case 'netTtfbMs': return s.bench.netTtfbMs;
    // Throughput is comparable only across the repo probe (SPEC 3.6).
    case 'netMbps': return s.bench.netProbe === 'repo' ? s.bench.netMbps : null;
    case 'totalDelaySec': return s.timing.totalDelaySec;
  }
}

export function regionKey(s: RawSample): string {
  return s.place.region ?? s.place.inferredRegion ?? 'unknown';
}

export function labelIndex(label: RunnerLabel): number {
  return LABELS.indexOf(label);
}
