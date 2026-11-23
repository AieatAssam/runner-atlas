// 24 hours by 7 weekdays. Sequential ramp on the median total start delay; every cell names its n on hover or focus.
import { scaleQuantize } from 'd3-scale';
import type { DriftCell, DriftRollup } from '../../../shared/types/rollups.ts';
import { WEEKDAYS, formatDuration, formatSlot } from '../lib/format.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { chartWidth, chartWrap, count, emptyNote, headCaption, summaryTable, svgEl, svgFor, svgText, tooltip } from './_axis.ts';

const LEFT = 40;
const TOP = 6;
const CELL_H = 22;
const LEGEND_H = 46;

function render(ctx: RenderContext, data: DriftRollup): void {
  const { tokens } = ctx;
  const width = chartWidth(ctx);
  const wrap = chartWrap(ctx);
  const cellW = (width - LEFT - 4) / 24;
  const height = TOP + 7 * CELL_H + 24 + LEGEND_H;
  const svg = svgFor(wrap, width, height, 'Median total start delay by weekday and hour, UTC. Darker cells wait longer.');

  const { min, max } = data.terrain;
  const hasRange = min !== null && max !== null && max > min;
  const lo = min ?? 0;
  const hi = hasRange ? (max as number) : lo + 1;
  const ramp = scaleQuantize<string>().domain([lo, hi]).range(tokens.sequential);
  const cells = data.weekdayHour;
  const rows: string[][] = [];

  cells.forEach((cell: DriftCell, index: number) => {
    const weekday = Math.floor(index / 24);
    const hour = index % 24;
    const median = cell.total?.median ?? null;
    const group = svgEl('g', { class: 'chart__mark', tabindex: 0, role: 'img' });
    const slot = formatSlot(weekday, hour);
    const text = median === null
      ? `${slot}: no runs yet, n = 0 runs`
      : `${slot}: median total delay ${formatDuration(median)}, n = ${count(cell.runs)} runs`;
    group.setAttribute('aria-label', text);
    group.append(svgEl('rect', {
      x: LEFT + hour * cellW, y: TOP + weekday * CELL_H, width: Math.max(1, cellW - 1), height: CELL_H - 1,
      fill: median === null ? tokens.paper2 : ramp(median),
    }));
    svg.append(group);
    tooltip(ctx, wrap, group, text);
    rows.push([formatSlot(weekday, hour), count(cell.runs), median === null ? 'not measured' : formatDuration(median)]);
  });

  WEEKDAYS.forEach((day, weekday) => {
    svgText(svg, LEFT - 6, TOP + weekday * CELL_H + CELL_H / 2 + 4, day.slice(0, 3), { 'text-anchor': 'end', fill: tokens.muted });
  });
  for (let hour = 0; hour < 24; hour += 3) {
    svgText(svg, LEFT + hour * cellW + cellW / 2, TOP + 7 * CELL_H + 16, String(hour).padStart(2, '0'), { 'text-anchor': 'middle', fill: tokens.muted });
  }

  // Legend: one swatch per ramp step, labelled with the domain ends.
  const legendY = TOP + 7 * CELL_H + 30;
  const step = Math.min(28, (width - LEFT) / tokens.sequential.length);
  tokens.sequential.forEach((colour, i) => {
    svg.append(svgEl('rect', { x: LEFT + i * step, y: legendY, width: step - 1, height: 8, fill: colour }));
  });
  svgText(svg, LEFT, legendY + 22, formatDuration(lo), { fill: tokens.muted });
  svgText(svg, LEFT + tokens.sequential.length * step, legendY + 22, formatDuration(hi), { 'text-anchor': 'end', fill: tokens.muted });

  if (!hasRange) emptyNote(wrap, 'No schedule events yet. Cells fill in as runs arrive.');
  summaryTable(wrap, 'Median start delay by slot', ['Slot', 'Runs', 'Median total delay'], rows);
}

export default {
  panel: 'drift-heatmap',
  caption: (data: DriftRollup) => headCaption(data, 'Schedule events only'),
  render,
} satisfies ChartModule<DriftRollup>;
