// Best and worst five slots. Each row shows its score and a 95% interval bar on one shared axis that starts at zero.
import { scaleLinear } from 'd3-scale';
import type { DriftRollup, SlotScore } from '../../../shared/types/rollups.ts';
import { formatDuration, formatInterval, formatSlot } from '../lib/format.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { chartWidth, chartWrap, count, emptyNote, headCaption, summaryTable, svgEl, svgFor, svgText, tickCount, tooltip } from './_axis.ts';

const ROW_H = 26;
const HEAD_H = 22;
const AXIS_H = 20;
const RIGHT = 84;

function render(ctx: RenderContext, data: DriftRollup): void {
  const { tokens } = ctx;
  const width = chartWidth(ctx);
  const wrap = chartWrap(ctx);
  const groups: Array<{ name: 'Best' | 'Worst'; slots: SlotScore[] }> = [
    { name: 'Best', slots: data.ranking.best.slice(0, 5) },
    { name: 'Worst', slots: data.ranking.worst.slice(0, 5) },
  ];
  const all = groups.flatMap((g) => g.slots);
  const left = Math.min(180, Math.round(width * 0.42));

  if (all.length === 0) {
    emptyNote(wrap, 'No ranked slots yet. Ranking starts once slots have enough runs.');
    summaryTable(wrap, 'Best and worst slots', ['Group', 'Slot', 'Score', 'Interval', 'Runs'], []);
    return;
  }

  const top = Math.max(...all.map((s) => s.ci95[1]));
  const x = scaleLinear().domain([0, top || 1]).nice().range([left + 8, width - RIGHT]);
  const rows: string[][] = [];

  for (const group of groups) {
    if (group.slots.length === 0) continue;
    const height = HEAD_H + group.slots.length * ROW_H + AXIS_H;
    const plotBottom = HEAD_H + group.slots.length * ROW_H;
    const svg = svgFor(wrap, width, height, `${group.name} ${group.slots.length} observed slots, score with 95% interval.`);
    svgText(svg, 0, 14, group.name === 'Best' ? 'Quickest slots' : 'Slowest slots', { fill: tokens.ink, 'font-weight': 600 });
    // One shared axis from zero: gridlines through the rows, tick labels under them.
    for (const v of x.ticks(tickCount(width - RIGHT - left, 5))) {
      svg.append(svgEl('line', { x1: x(v), x2: x(v), y1: HEAD_H, y2: plotBottom, stroke: tokens.rule, 'stroke-width': 1 }));
      svgText(svg, x(v), plotBottom + 14, formatDuration(v), { 'text-anchor': 'middle', fill: tokens.muted });
    }
    group.slots.forEach((slot, row) => {
      const y = HEAD_H + row * ROW_H + ROW_H / 2;
      const name = formatSlot(slot.weekday, slot.hourUtc);
      const interval = formatInterval(slot.ci95[0], slot.ci95[1]);
      const text = `${name}: wait score ${formatDuration(slot.score)}, 95% interval ${interval}, n = ${count(slot.runs)} runs`;
      const g = svgEl('g');
      g.append(svgEl('rect', { x: 0, y: y - ROW_H / 2, width, height: ROW_H, fill: 'none', 'pointer-events': 'all' }));
      svgText(g, 0, y + 4, name, { fill: tokens.ink2 });
      g.append(svgEl('path', { d: `M${x(slot.ci95[0])},${y}H${x(slot.ci95[1])}`, stroke: tokens.ink, 'stroke-width': 2 }));
      g.append(svgEl('path', { d: `M${x(slot.ci95[0])},${y - 5}V${y + 5}M${x(slot.ci95[1])},${y - 5}V${y + 5}`, stroke: tokens.ink, 'stroke-width': 1 }));
      g.append(svgEl('circle', { cx: x(slot.score), cy: y, r: 3.5, fill: group.name === 'Best' ? tokens.diverging.low : tokens.diverging.high }));
      svgText(g, width - RIGHT + 8, y + 4, formatDuration(slot.score), { fill: tokens.ink, 'text-anchor': 'start' });
      svg.append(g);
      tooltip(ctx, wrap, g, text);
      rows.push([group.name, name, formatDuration(slot.score), interval, count(slot.runs)]);
    });
  }

  const note = data.ranking.granularity === 'hour' ? 'Ranked by hour of day, weekday not separated' : undefined;
  summaryTable(wrap, 'Best and worst slots', ['Group', 'Slot', 'Score', 'Interval', 'Runs'], rows);
  if (note) emptyNote(wrap, note);
}

export default {
  panel: 'slot-ranking',
  caption: (data: DriftRollup) => headCaption(data),
  render,
} satisfies ChartModule<DriftRollup>;
