// Fleet composition (SPEC 4.2 fleet): labels, hardware, images, regions and the label -> hardware -> region flow.
import type { DiskKind, RawSample, RunnerLabel } from '../../shared/types/sample.ts';
import type { FleetRollup } from '../../shared/types/rollups.ts';
import { LABELS, cmp, regionKey } from './common.ts';
import { cpuFamily } from './hardware.ts';
import { countsSorted, countRuns, headOf, mostCommon, q5, type Ctx } from './summary.ts';

export function buildFleet(ctx: Ctx): FleetRollup {
  const labels = LABELS.flatMap((label: RunnerLabel) => {
    const ls = ctx.samples.filter((s) => s.label === label);
    if (ls.length === 0) return [];
    const diskKinds: Partial<Record<DiskKind, number>> = {};
    for (const [kind, n] of countsSorted(ls.map((s) => s.disk.kind))) diskKinds[kind as DiskKind] = n;
    return [{
      label,
      os: mostCommon(ls.map((s) => s.os.name)) ?? 'unknown',
      arch: mostCommon(ls.map((s) => s.env.runnerArch)) ?? 'unknown',
      samples: ls.length,
      runs: countRuns(ls),
      cpuFamilies: countsSorted(ls.map((s) => cpuFamily(s.cpu.model))).map(([family, n]) => ({ family, n })),
      memGB: q5(ls.map((s) => s.memGB), 1),
      diskKinds,
      imageVersion: mostCommon(ls.map((s) => s.env.imageVersion)),
      agentVersion: mostCommon(ls.map((s) => s.env.agentVersion)),
    }];
  });

  const toRows = (pairs: Array<[string, number]>) => pairs.map(([key, n]) => ({ key, n }));
  const breakdown = {
    osVersions: toRows(countsSorted(ctx.samples.map((s) => s.os.version))),
    imageVersions: toRows(countsSorted(ctx.samples.flatMap((s) => (s.env.imageVersion === null ? [] : [s.env.imageVersion])))),
    regions: toRows(countsSorted(ctx.samples.map(regionKey))),
  };

  // label -> cpuFamily -> region flow.
  const lf = new Map<string, number>();
  const fr = new Map<string, number>();
  const nodes = new Map<string, { id: string; kind: 'label' | 'hardware' | 'region'; name: string }>();
  for (const s of ctx.samples) {
    const fam = cpuFamily(s.cpu.model);
    const reg = regionKey(s);
    const a = `label:${s.label}`;
    const b = `hw:${fam}`;
    const c = `region:${reg}`;
    lf.set(`${a}\u0000${b}`, (lf.get(`${a}\u0000${b}`) ?? 0) + 1);
    fr.set(`${b}\u0000${c}`, (fr.get(`${b}\u0000${c}`) ?? 0) + 1);
    nodes.set(a, { id: a, kind: 'label', name: s.label });
    nodes.set(b, { id: b, kind: 'hardware', name: fam });
    nodes.set(c, { id: c, kind: 'region', name: reg });
  }
  const link = (m: Map<string, number>) =>
    [...m.entries()]
      .map(([k, value]) => {
        const [source, target] = k.split('\u0000');
        return { source, target, value };
      })
      .sort((x, y) => cmp(x.source, y.source) || cmp(x.target, y.target));

  const recentSamples = ctx.samples.slice(-20).reverse().map((s) => ({
    id: s.id,
    collectedAtIso: s.collectedAtIso,
    label: s.label,
    cpuFamily: cpuFamily(s.cpu.model),
    region: regionKey(s),
    singleCoreScore: s.bench.singleCoreScore === null ? null : Math.round(s.bench.singleCoreScore * 100) / 100,
    totalDelaySec: s.timing.totalDelaySec === null ? null : Math.round(s.timing.totalDelaySec * 10) / 10,
  }));

  return {
    ...headOf('fleet', ctx),
    labels,
    breakdown,
    sankey: {
      nodes: [...nodes.values()].sort((x, y) => cmp(x.id, y.id)),
      links: [...link(lf), ...link(fr)],
    },
    recentSamples,
  };
}
