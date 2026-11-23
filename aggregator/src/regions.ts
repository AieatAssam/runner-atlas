// Region map rows (SPEC 4.1 region key). Regions without coordinates are excluded and counted in `unknown`.
import type { RawSample, RunnerLabel } from '../../shared/types/sample.ts';
import type { RegionsRollup } from '../../shared/types/rollups.ts';
import { DECIMALS, LABELS, cmp, regionKey, round, roundOrNull } from './common.ts';
import { cpuFamily } from './hardware.ts';
import { countsSorted, headOf, medianOf, type Ctx } from './summary.ts';

export interface Coord { lat: number; lon: number; label: string }

export function buildRegions(ctx: Ctx, coords: Record<string, Coord>): RegionsRollup {
  const total = ctx.samples.length;
  const groups = new Map<string, RawSample[]>();
  let unknown = 0;
  for (const s of ctx.samples) {
    const r = regionKey(s);
    if (!Object.hasOwn(coords, r)) {
      unknown++;
      continue;
    }
    const g = groups.get(r);
    if (g) g.push(s);
    else groups.set(r, [s]);
  }

  const regions = [...groups.entries()].map(([region, ls]) => {
    const methods = new Set(ls.map((s) => s.place.method));
    const method: RegionsRollup['regions'][number]['method'] =
      methods.size === 1 && methods.has('imds') ? 'imds' : methods.size === 1 && methods.has('cidr') ? 'cidr' : 'mixed';
    const labels: Partial<Record<RunnerLabel, number>> = {};
    for (const label of LABELS) {
      const n = ls.filter((s) => s.label === label).length;
      if (n > 0) labels[label] = n;
    }
    const delays = ls.filter((s) => s.event === 'schedule').map((s) => s.timing.totalDelaySec);
    const c = coords[region];
    return {
      region,
      method,
      lat: round(c.lat, 2),
      lon: round(c.lon, 2),
      samples: ls.length,
      share: round(ls.length / total, 4),
      labels,
      ttfbMedianMs: roundOrNull(medianOf(ls.map((s) => s.bench.netTtfbMs)), DECIMALS.netTtfbMs),
      totalDelayMedianSec: roundOrNull(medianOf(delays), DECIMALS.totalDelaySec),
      cpuFamilies: countsSorted(ls.map((s) => cpuFamily(s.cpu.model))).map(([family, n]) => ({ family, n })),
    };
  });
  regions.sort((a, b) => b.samples - a.samples || cmp(a.region, b.region));

  return { ...headOf('regions', ctx), regions, unknown: { samples: unknown } };
}
