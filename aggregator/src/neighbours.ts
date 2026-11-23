// Steal and neighbour effects on Linux (SPEC 4.5).
import type { RawSample, RunnerLabel } from '../../shared/types/sample.ts';
import type { NeighboursRollup } from '../../shared/types/rollups.ts';
import { LINUX_LABELS, cmp, round, roundOrNull, runKey } from './common.ts';
import { cpuFamily } from './hardware.ts';
import { fnv1a32 } from './prng.ts';
import { bootstrapCI, mad, median, olsFit, pearson, quantile, spearman } from './stats.ts';
import { headOf, type Ctx } from './summary.ts';

const MAX_POINTS = 1500;
const MIN_GROUP = 20;
const BUCKETS: Array<[number, number | null]> = [[0, 0.5], [0.5, 1], [1, 2], [2, 5], [5, null]];

interface Pt {
  id: string;
  idx: number;
  label: RunnerLabel;
  family: string;
  steal: number;
  z: number;
  run: string;
}

export function buildNeighbours(ctx: Ctx): NeighboursRollup {
  const linux = ctx.samples.filter(
    (s) => (LINUX_LABELS as readonly string[]).includes(s.label) && s.bench.singleCoreScore !== null,
  );
  const groups = new Map<string, RawSample[]>();
  for (const s of linux) {
    const k = `${s.label}|${cpuFamily(s.cpu.model)}`;
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  const zById = new Map<string, number>();
  for (const g of groups.values()) {
    if (g.length < MIN_GROUP) continue;
    const xs = g.map((s) => s.bench.singleCoreScore as number);
    const med = median(xs);
    const m = mad(xs);
    if (!(m > 0)) continue;
    for (const s of g) zById.set(s.id, ((s.bench.singleCoreScore as number) - med) / m);
  }

  const pts: Pt[] = [];
  ctx.samples.forEach((s, idx) => {
    const z = zById.get(s.id);
    if (z === undefined || s.stealPct === null) return;
    if (!(LINUX_LABELS as readonly string[]).includes(s.label)) return;
    pts.push({ id: s.id, idx, label: s.label, family: cpuFamily(s.cpu.model), steal: s.stealPct, z, run: runKey(s) });
  });

  const steals = pts.map((p) => p.steal);
  const zs = pts.map((p) => p.z);
  const ols = olsFit(steals, zs);
  const rho = spearman(steals, zs);
  // rho CI: cluster bootstrap over runs (SPEC 4.5); a run's points are resampled together.
  const byRun = new Map<string, Pt[]>();
  for (const p of pts) {
    const g = byRun.get(p.run);
    if (g) g.push(p);
    else byRun.set(p.run, [p]);
  }
  const rhoCi = bootstrapCI([...byRun.values()], 'neighbours:rho', (rs) => {
    const r = rs.flat();
    return spearman(r.map((p) => p.steal), r.map((p) => p.z));
  });

  const buckets = BUCKETS.map(([lo, hi]) => {
    const inB = pts.filter((p) => p.steal >= lo && (hi === null || p.steal < hi));
    const bz = inB.map((p) => p.z);
    const n = inB.length;
    // Zero when n = 0; read n first.
    return {
      lo,
      hi,
      n,
      zMedian: n ? round(median(bz), 3) : 0,
      zP25: n ? round(quantile(bz, 0.25), 3) : 0,
      zP75: n ? round(quantile(bz, 0.75), 3) : 0,
      absZMedian: n ? round(median(bz.map(Math.abs)), 3) : 0,
    };
  });

  // Point cap: lowest hash, then restored to time order.
  const kept = [...pts]
    .sort((a, b) => fnv1a32(a.id) - fnv1a32(b.id) || cmp(a.id, b.id))
    .slice(0, MAX_POINTS)
    .sort((a, b) => a.idx - b.idx);
  const families = [...new Set(kept.map((p) => p.family))].sort(cmp);
  const famIdx = new Map(families.map((f, i) => [f, i]));
  const labelsOut = [...LINUX_LABELS];

  const hwKeys = new Map<string, RawSample[]>();
  for (const s of linux) {
    if (s.stealPct === null) continue;
    const k = `${s.label}\u0000${cpuFamily(s.cpu.model)}`;
    const g = hwKeys.get(k);
    if (g) g.push(s);
    else hwKeys.set(k, [s]);
  }
  const byHardware = [...hwKeys.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([k, g]) => {
      const [label, family] = k.split('\u0000') as [RunnerLabel, string];
      const st = g.map((s) => s.stealPct as number);
      const gp = pts.filter((p) => p.label === label && p.family === family);
      const gz = gp.map((p) => p.z);
      const gs = gp.map((p) => p.steal);
      return {
        label,
        cpuFamily: family,
        n: g.length,
        stealMedian: round(median(st), 2),
        stealP90: round(quantile(st, 0.9), 2),
        rho: roundOrNull(spearman(gs, gz), 3),
        slope: (() => {
          const f = olsFit(gs, gz);
          return f ? round(f.slope, 3) : null;
        })(),
      };
    });

  return {
    ...headOf('neighbours', ctx),
    overall: {
      n: pts.length,
      spearmanRho: roundOrNull(rho, 3),
      rhoCi95: rhoCi ? [round(rhoCi[0], 3), round(rhoCi[1], 3)] : null,
      rhoAbs: roundOrNull(spearman(steals, zs.map(Math.abs)), 3),
      pearsonR: roundOrNull(pearson(steals, zs), 3),
      slope: ols ? round(ols.slope, 3) : null,
      intercept: ols ? round(ols.intercept, 3) : null,
    },
    buckets,
    points: {
      labels: labelsOut,
      families,
      steal: kept.map((p) => round(p.steal, 2)),
      z: kept.map((p) => round(p.z, 3)),
      label: kept.map((p) => labelsOut.indexOf(p.label)),
      family: kept.map((p) => famIdx.get(p.family) ?? 0),
    },
    byHardware,
  };
}
