// Benchmark distributions per metric, label and label x cpuFamily; stratified points for the scatter (SPEC 4.4).
import type { RawSample, RunnerLabel } from '../../shared/types/sample.ts';
import type { BenchmarksRollup, GroupSummary, MetricId } from '../../shared/types/rollups.ts';
import { DECIMALS, LABELS, METRICS, cmp, labelIndex, metricValue, round } from './common.ts';
import { cpuFamily } from './hardware.ts';
import { fnv1a32 } from './prng.ts';
import { gaussianKdeScaled, histogram, mad, quantileSorted, silvermanBandwidth, sortAsc } from './stats.ts';
import { headOf, q5, type Ctx } from './summary.ts';

const UNIT: Record<MetricId, string> = {
  singleCoreScore: 'Mops/s',
  multiCoreScore: 'Mops/s',
  seqWriteMBs: 'MB/s',
  seqReadMBs: 'MB/s',
  memBandwidthGBs: 'GB/s',
  netTtfbMs: 'ms',
  netMbps: 'Mbit/s',
};
const BETTER: Record<MetricId, 'higher' | 'lower'> = {
  singleCoreScore: 'higher',
  multiCoreScore: 'higher',
  seqWriteMBs: 'higher',
  seqReadMBs: 'higher',
  memBandwidthGBs: 'higher',
  netTtfbMs: 'lower',
  netMbps: 'higher',
};
const POINTS_PER_LABEL = 333; // 6 x 333 <= 2000
const BEESWARM_PER_LABEL = 120;

function domainOf(values: number[], metric: MetricId): [number, number] | null {
  if (values.length === 0) return null;
  const s = sortAsc(values);
  let lo = quantileSorted(s, 0.01);
  let hi = quantileSorted(s, 0.99);
  if (lo === hi) {
    const w = Math.max(0.5, 0.01 * Math.abs(lo));
    lo -= w;
    hi += w;
  }
  const d = DECIMALS[metric];
  return [round(lo, d), round(hi, d)];
}

function gridOf(domain: [number, number], d: number): number[] {
  const [lo, hi] = domain;
  return Array.from({ length: 64 }, (_, i) => round(lo + ((hi - lo) * i) / 63, d));
}

function groupOf(
  values: number[],
  metric: MetricId,
  domain: [number, number],
  grid: number[],
  label: RunnerLabel,
  family: string | null,
): GroupSummary {
  const d = DECIMALS[metric];
  const n = values.length;
  const kde = n >= 5
    ? gaussianKdeScaled(values, grid, silvermanBandwidth(values, domain)).map((v) => round(v, 3))
    : [];
  return {
    key: family === null ? label : `${label}|${family}`,
    label,
    cpuFamily: family,
    n,
    q: q5(values, d),
    mad: round(mad(values), d),
    kde,
    hist: histogram(values, domain),
  };
}

export function buildBenchmarks(ctx: Ctx): BenchmarksRollup {
  // label -> family -> samples, built once.
  const byLF = new Map<RunnerLabel, Map<string, RawSample[]>>();
  for (const label of LABELS) byLF.set(label, new Map());
  for (const s of ctx.samples) {
    const fam = cpuFamily(s.cpu.model);
    const m = byLF.get(s.label)!;
    const g = m.get(fam);
    if (g) g.push(s);
    else m.set(fam, [s]);
  }

  const metrics = METRICS.map((id) => {
    const values: number[] = ctx.samples.flatMap((s) => {
      const v = metricValue(s, id);
      return v === null ? [] : [v];
    });
    const domain = domainOf(values, id);
    return {
      id,
      unit: UNIT[id],
      better: BETTER[id],
      n: values.length,
      domain,
      grid: domain ? gridOf(domain, DECIMALS[id]) : [],
    };
  });

  const byLabel = {} as Record<MetricId, GroupSummary[]>;
  const byHardware = {} as Record<MetricId, GroupSummary[]>;
  for (const m of metrics) {
    const { id, domain, grid } = m;
    byLabel[id] = [];
    byHardware[id] = [];
    if (!domain) continue;
    for (const label of LABELS) {
      const fams = byLF.get(label)!;
      const all: number[] = [];
      const famRows: GroupSummary[] = [];
      for (const fam of [...fams.keys()].sort(cmp)) {
        const vals = fams.get(fam)!.flatMap((s) => {
          const v = metricValue(s, id);
          return v === null ? [] : [v];
        });
        if (vals.length === 0) continue;
        all.push(...vals);
        famRows.push(groupOf(vals, id, domain, grid, label, fam));
      }
      if (all.length === 0) continue;
      byLabel[id].push(groupOf(all, id, domain, grid, label, null));
      byHardware[id].push(...famRows);
    }
  }

  // Points: samples with single, write, mem and multi all present; lowest hash per label.
  const complete = (s: RawSample) =>
    s.bench.singleCoreScore !== null && s.bench.seqWriteMBs !== null &&
    s.bench.memBandwidthGBs !== null && s.bench.multiCoreScore !== null;
  const chosen = new Set<string>();
  for (const label of LABELS) {
    const cand = ctx.samples
      .filter((s) => s.label === label && complete(s))
      .map((s) => ({ id: s.id, h: fnv1a32(s.id) }))
      .sort((a, b) => a.h - b.h || cmp(a.id, b.id))
      .slice(0, POINTS_PER_LABEL);
    for (const c of cand) chosen.add(c.id);
  }
  const pts = ctx.samples.filter((s) => chosen.has(s.id));
  const families = [...new Set(pts.map((s) => cpuFamily(s.cpu.model)))].sort(cmp);
  const famIdx = new Map(families.map((f, i) => [f, i]));

  const beeswarm: number[] = [];
  for (const label of LABELS) {
    const idxs = pts.flatMap((s, i) => (s.label === label ? [i] : []));
    idxs.sort((a, b) => fnv1a32(pts[a].id) - fnv1a32(pts[b].id) || cmp(pts[a].id, pts[b].id));
    beeswarm.push(...idxs.slice(0, BEESWARM_PER_LABEL));
  }
  beeswarm.sort((a, b) => a - b);

  return {
    ...headOf('benchmarks', ctx),
    metrics,
    byLabel,
    byHardware,
    points: {
      labels: [...LABELS],
      families,
      id: pts.map((s) => s.id),
      label: pts.map((s) => labelIndex(s.label)),
      family: pts.map((s) => famIdx.get(cpuFamily(s.cpu.model)) ?? 0),
      single: pts.map((s) => round(s.bench.singleCoreScore!, DECIMALS.singleCoreScore)),
      write: pts.map((s) => round(s.bench.seqWriteMBs!, DECIMALS.seqWriteMBs)),
      mem: pts.map((s) => round(s.bench.memBandwidthGBs!, DECIMALS.memBandwidthGBs)),
      multi: pts.map((s) => round(s.bench.multiCoreScore!, DECIMALS.multiCoreScore)),
      date: pts.map((s) => s.collectedAtIso.slice(0, 10)),
    },
    beeswarm,
  };
}
