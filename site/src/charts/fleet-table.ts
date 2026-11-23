// Ruled table of samples per label, with its CPU families, memory and the region breakdown.
import type { FleetRollup } from '../../../shared/types/rollups.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { count, fixed, headCaption, ruledTable } from './_axis.ts';

function render(ctx: RenderContext, data: FleetRollup): void {
  const rows = data.labels.map((l) => [
    l.label,
    `${l.os}, ${l.arch}`,
    count(l.samples),
    count(l.runs),
    l.cpuFamilies.map((f) => `${f.family} (${count(f.n)})`).join(', ') || 'not measured',
    l.memGB ? `${fixed(l.memGB.p50, 1)} GB` : 'not measured',
  ]);
  ruledTable(ctx, 'Samples by label', ['Label', 'System', 'Samples', 'Runs', 'CPU families', 'Median memory'], rows);
  ruledTable(ctx, 'Samples by region', ['Region', 'Samples'],
    data.breakdown.regions.map((r) => [r.key, count(r.n)]));
}

export default {
  panel: 'fleet-table',
  caption: (data: FleetRollup) => headCaption(data),
  render,
} satisfies ChartModule<FleetRollup>;
