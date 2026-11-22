// Rollup contracts (SPEC 4.2), one schema each under schemas/rollups/. `Head.schema` is `runner-atlas/<file>@1`.
import type { RunnerLabel, DiskKind } from './sample.ts';

export type RollupName = 'fleet' | 'benchmarks' | 'drift' | 'neighbours' | 'rollouts' | 'seasonality' | 'regions';
export type TierId = 'day1' | 'day3' | 'day7' | 'day14' | 'day30' | 'day90';
export type ConfidenceTier = 'insufficient' | 'preliminary' | 'emerging' | 'established' | 'high';
export type MetricId = 'singleCoreScore' | 'multiCoreScore' | 'seqWriteMBs' | 'seqReadMBs' | 'memBandwidthGBs' | 'netTtfbMs' | 'netMbps';
export interface DateRange { from: string; to: string }
export interface Head { schema: string; range: DateRange | null; n: { samples: number; runs: number } }
export interface Q4 { median: number; p25: number; p75: number; p95: number }
export interface Q5 { p10: number; p25: number; p50: number; p75: number; p90: number }
export interface SlotScore { weekday: number | null; hourUtc: number; runs: number; samples: number; medianSec: number; p90Sec: number; score: number; ci95: [number, number] }

export interface Manifest extends Head {            // manifest.json
  dataSource: 'empty' | 'live' | 'synthetic';
  firstSampleIso: string | null; lastSampleIso: string | null;
  surveyDay: number; labelsActive: RunnerLabel[];
  slotsExpected: number; slotsObserved: number; coverage: number | null;
  tiers: Array<{ id: TierId; minDays: number; minSamples: number; status: 'open' | 'charting'; samplesNeeded: number; daysNeeded: number; opensOn: string | null }>;
  headline: { tier: ConfidenceTier; granularity: 'hour' | 'weekday-hour' | null; best: SlotScore | null; worst: SlotScore | null; separated: boolean | null; reason: string | null };
  fieldLog: Array<{ date: string; partial: boolean; text: string }>;   // newest first
  files: Array<{ name: RollupName; path: string; bytes: number; sha256: string }>;
}
export interface FleetRollup extends Head {          // fleet.json
  labels: Array<{ label: RunnerLabel; os: string; arch: string; samples: number; runs: number; cpuFamilies: Array<{ family: string; n: number }>; memGB: Q5 | null; diskKinds: Partial<Record<DiskKind, number>>; imageVersion: string | null; agentVersion: string | null }>;
  breakdown: { osVersions: Array<{ key: string; n: number }>; imageVersions: Array<{ key: string; n: number }>; regions: Array<{ key: string; n: number }> };
  sankey: { nodes: Array<{ id: string; kind: 'label' | 'hardware' | 'region'; name: string }>; links: Array<{ source: string; target: string; value: number }> };  // label -> cpuFamily -> region
  recentSamples: Array<{ id: string; collectedAtIso: string; label: RunnerLabel; cpuFamily: string; region: string; singleCoreScore: number | null; totalDelaySec: number | null }>;  // latest 20
}
export interface GroupSummary { key: string; label: RunnerLabel | null; cpuFamily: string | null; n: number; q: Q5; mad: number; kde: number[]; hist: number[] }
// key: "<label>" in byLabel, "<label>|<cpuFamily>" in byHardware. kde: 64 values on the metric grid, [] when n < 5. hist: 32 counts over domain, always present. Groups with n == 0 are omitted.
export interface BenchmarksRollup extends Head {     // benchmarks.json
  metrics: Array<{ id: MetricId; unit: string; better: 'higher' | 'lower'; n: number; domain: [number, number] | null; grid: number[] }>;  // always all 7, in MetricId order; grid: 64 x values over domain, [] and domain null when n == 0
  byLabel: Record<MetricId, GroupSummary[]>; byHardware: Record<MetricId, GroupSummary[]>;   // every MetricId key always present, [] when empty
  points: { labels: string[]; families: string[]; id: string[]; label: number[]; family: number[]; single: number[]; write: number[]; mem: number[]; multi: number[]; date: string[] };
  // column arrays of equal length; only samples where single, write, mem and multi are all non-null; <= 2000 by lowest fnv1a32(id), stratified by label
  beeswarm: number[];                                // indices into points, <= 120 per label (lowest fnv1a32(id)); beeswarm draws single, multi, write, mem only
}
export interface DriftCell { weekday: number | null; hourUtc: number; runs: number; samples: number; drift: Q4 | null; queue: Q4 | null; total: Q4 | null; score: number | null; ci95: [number, number] | null }
// DriftCell: drift/queue/total null when runs == 0; score/ci95 null when runs < 3 (4.3).
export interface DriftRollup extends Head {          // drift.json (schedule events only)
  weekdayHour: DriftCell[];                          // always 168, index = weekday * 24 + hourUtc
  byHour: DriftCell[];                               // always 24, weekday null
  byLabel: Array<{ label: RunnerLabel; byHour: Array<{ hourUtc: number; runs: number; queue: Q4 | null }> }>;
  ranking: { granularity: 'hour' | 'weekday-hour' | null; best: SlotScore[]; worst: SlotScore[] };   // top 5 each
  slots: { expected: number; observed: number; missedByHour: number[] };
  terrain: { min: number | null; max: number | null; contours: number[] };
  // min/max of weekdayHour total.median over cells with runs > 0 (seconds); contours = d3-array ticks(min, max, 6) strictly inside (min, max); [] when fewer than 2 such cells or min == max
}
export interface NeighboursRollup extends Head {     // neighbours.json (Linux only)
  overall: { n: number; spearmanRho: number | null; rhoCi95: [number, number] | null; rhoAbs: number | null; pearsonR: number | null; slope: number | null; intercept: number | null };
  buckets: Array<{ lo: number; hi: number | null; n: number; zMedian: number; zP25: number; zP75: number; absZMedian: number }>;  // steal % [0,.5) [.5,1) [1,2) [2,5) [5,inf)
  points: { labels: string[]; families: string[]; steal: number[]; z: number[]; label: number[]; family: number[] };   // <= 1500
  byHardware: Array<{ label: RunnerLabel; cpuFamily: string; n: number; stealMedian: number; stealP90: number; rho: number | null; slope: number | null }>;
}
export interface RolloutsRollup extends Head {       // rollouts.json
  days: string[];
  byLabel: Array<{ label: RunnerLabel; images: Array<{ version: string; firstSeen: string; lastSeen: string; share: Array<number | null> }>; families: Array<{ family: string; share: Array<number | null> }>; events: Array<{ date: string; from: string; to: string }> }>;
  // days: every UTC date from range.from to range.to inclusive, gap days included. share arrays align to days; null on a day the label has no samples.
  // images and families: top 7 by samples per label, the rest pooled as version/family "other".
  changePoints: Array<{ label: RunnerLabel; metric: MetricId | 'totalDelaySec'; date: string; before: { median: number; n: number }; after: { median: number; n: number }; shiftPct: number; u: number; pRaw: number; pAdj: number; nearImageEvent: boolean }>;
  method: { test: 'mann-whitney-u'; alpha: 0.05; minSegmentDays: 3; minSegmentSamples: 30; minShiftPct: 3; maxPerSeries: 3 };
}
export interface SeasonalityRollup extends Head {    // seasonality.json
  days: string[];
  daily: Record<MetricId | 'totalDelaySec', { n: number[]; p10: Array<number | null>; p50: Array<number | null>; p90: Array<number | null>; roll7: { p10: Array<number | null>; p50: Array<number | null>; p90: Array<number | null> } }>;
  // all arrays align to days (every UTC date in range, gaps included); a day's quantiles are null when its n < 20
  weekdayEffect: Record<'totalDelaySec' | 'singleCoreScore', Array<{ weekday: number; n: number; effect: number | null; ci95: [number, number] | null }>>;   // always 7 rows
  diurnalEffect: Record<'totalDelaySec' | 'singleCoreScore', Array<{ hourUtc: number; n: number; effect: number | null; ci95: [number, number] | null }>>;  // always 24 rows
  // effect/ci95 null when that row's n (runs for totalDelaySec, samples for singleCoreScore) < 3
  acf: { dailyTotalDelay: Array<number | null>; hourlyTotalDelay: Array<number | null> };   // always 14 and 168 entries (lags 1..14, 1..168); null when fewer than 10 pairs
  trend: Record<MetricId | 'totalDelaySec', { theilSenPerWeek: number | null; ci95: [number, number] | null }>;   // null with fewer than 14 non-null daily medians
}
export interface RegionsRollup extends Head {        // regions.json
  regions: Array<{ region: string; method: 'imds' | 'cidr' | 'mixed'; lat: number; lon: number; samples: number; share: number; labels: Partial<Record<RunnerLabel, number>>; ttfbMedianMs: number | null; totalDelayMedianSec: number | null; cpuFamilies: Array<{ family: string; n: number }> }>;
  unknown: { samples: number };
}
