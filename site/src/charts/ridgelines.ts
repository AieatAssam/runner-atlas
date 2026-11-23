// One small multiple per metric. Rows are labels; each row is a KDE ridge with a p50 tick.
import { area } from 'd3-shape';
import { axisBottom } from 'd3-axis';
import { scaleLinear } from 'd3-scale';
import { select } from 'd3-selection';
import type { BenchmarksRollup, GroupSummary } from '../../../shared/types/rollups.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { chartWidth, chartWrap, count, emptyNote, fixed, headCaption, labelColor, metricName, tickCount, ZOOMED_NOTE, summaryTable, svgEl, svgFor, svgText, tooltip } from './_axis.ts';

const ROW_H = 44;
const LEFT = 120;
const RIGHT = 16;

function render(ctx: RenderContext, data: BenchmarksRollup): void {
  const { tokens } = ctx;
  const width = chartWidth(ctx);
  const wrap = chartWrap(ctx);
  const rows: string[][] = [];

  for (const metric of data.metrics) {
    const groups = data.byLabel[metric.id] ?? [];
    const sized = groups.filter((g) => g.n > 0);
    const name = metricName(metric.id);
    if (!metric.domain || sized.length === 0) {
      emptyNote(wrap, `${name}: no samples yet.`);
      continue;
    }
    const height = 34 + sized.length * ROW_H + 26;
    const svg = svgFor(wrap, width, height, `${name} by label, ${sized.length} rows, median and spread in ${metric.unit}.`);
    svgText(svg, 0, 14, `${name}, ${metric.unit}`, { fill: tokens.ink, 'font-weight': 600 });

    const x = scaleLinear().domain(metric.domain).range([LEFT, width - RIGHT]).clamp(true);
    const top = 34;
    sized.forEach((group: GroupSummary, row: number) => {
      // n is in samples: benchmark groups count non-null values, not runs.
      const label = group.label ?? group.key;
      const baseline = top + row * ROW_H + ROW_H - 8;
      const grid = metric.grid;
      const peak = Math.max(0, ...group.kde);
      const hill = scaleLinear().domain([0, peak || 1]).range([0, ROW_H]);
      const ridge = group.kde.length === grid.length && peak > 0;
      const g = svgEl<SVGGElement>('g');
      const colour = labelColor(tokens, group.label);
      if (ridge) {
        const path = area<number>()
          .x((_, i) => x(grid[i] ?? 0))
          .y0(baseline)
          .y1((_, i) => baseline - hill(group.kde[i] ?? 0));
        g.append(svgEl('path', { d: path(grid) ?? '', fill: colour, 'fill-opacity': 0.35, stroke: colour, 'stroke-width': 1.25 }));
      }
      // The pointer target spans the row, so a row with no ridge (n under 5) still takes focus.
      g.append(svgEl('rect', { x: LEFT, y: baseline - ROW_H + 4, width: width - LEFT - RIGHT, height: ROW_H - 4, fill: 'none', 'pointer-events': 'all' }));
      g.append(svgEl('path', { d: `M${x(group.q.p50)},${baseline - ROW_H * 0.6}V${baseline}`, stroke: tokens.ink, 'stroke-width': 1.5 }));
      svg.append(g);
      svgText(svg, LEFT - 8, baseline - 2, `${label}`, { 'text-anchor': 'end', fill: tokens.ink2 });
      svgText(svg, LEFT - 8, baseline + 10, `n = ${count(group.n)}`, { 'text-anchor': 'end', fill: tokens.muted });
      tooltip(ctx, wrap, g, `${label}, ${name}: median ${fixed(group.q.p50, 1)} ${metric.unit}, n = ${count(group.n)} samples`);
      rows.push([name, label, count(group.n), fixed(group.q.p25, 1), fixed(group.q.p50, 1), fixed(group.q.p75, 1)]);
    });

    const axis = svgEl<SVGGElement>('g', { transform: `translate(0,${height - 26})` });
    svg.append(axis);
    select(axis).call(axisBottom(x).ticks(tickCount(width - LEFT - RIGHT)));
  }

  summaryTable(wrap, 'Speed by label: quartiles per metric', ['Metric', 'Label', 'Samples', 'p25', 'p50', 'p75'], rows);
}

export default {
  panel: 'ridgelines',
  caption: (data: BenchmarksRollup) => headCaption(data, ZOOMED_NOTE),
  render,
} satisfies ChartModule<BenchmarksRollup>;
