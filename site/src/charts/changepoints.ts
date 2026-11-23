// Ruled table of the change points that passed the test: where, how big, and how strong the evidence is.
import type { RolloutsRollup } from '../../../shared/types/rollups.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { count, fixed, headCaption, metricName, ruledTable } from './_axis.ts';

function p(value: number): string {
  return value < 0.001 ? '< 0.001' : fixed(value, 3);
}

function render(ctx: RenderContext, data: RolloutsRollup): void {
  const sorted = [...data.changePoints].sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
  ruledTable(ctx, 'Change points', ['Label', 'Metric', 'Date', 'Before (median, n)', 'After (median, n)', 'Shift', 'Adjusted p', 'Near image change'],
    sorted.map((c) => [
      c.label,
      metricName(c.metric),
      c.date,
      `${fixed(c.before.median, 1)} (n = ${count(c.before.n)})`,
      `${fixed(c.after.median, 1)} (n = ${count(c.after.n)})`,
      `${c.shiftPct > 0 ? '+' : ''}${fixed(c.shiftPct, 1)}%`,
      p(c.pAdj),
      c.nearImageEvent ? 'yes' : 'no',
    ]));
}

export default {
  panel: 'changepoints',
  caption: (data: RolloutsRollup) => headCaption(data, `Mann-Whitney U test, false discovery rate ${data.method.alpha * 100}%, shifts of at least ${data.method.minShiftPct}%`),
  render,
} satisfies ChartModule<RolloutsRollup>;
