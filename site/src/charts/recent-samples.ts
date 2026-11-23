// Ruled table of the latest measured runs, newest first.
import type { FleetRollup } from '../../../shared/types/rollups.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { fixed, headCaption, ruledTable } from './_axis.ts';
import { formatDuration } from '../lib/format.ts';

function render(ctx: RenderContext, data: FleetRollup): void {
  const newest = [...data.recentSamples].sort((a, b) => b.collectedAtIso.localeCompare(a.collectedAtIso));
  ruledTable(ctx, 'Recent samples', ['Collected (UTC)', 'Label', 'CPU family', 'Region', 'Single core score', 'Start delay'],
    newest.map((s) => [
      s.collectedAtIso.slice(0, 16).replace('T', ' '),
      s.label,
      s.cpuFamily,
      s.region,
      s.singleCoreScore === null ? 'not measured' : fixed(s.singleCoreScore, 1),
      s.totalDelaySec === null ? 'not measured' : formatDuration(s.totalDelaySec),
    ]));
}

export default {
  panel: 'recent-samples',
  caption: (data: FleetRollup) => headCaption(data),
  render,
} satisfies ChartModule<FleetRollup>;
