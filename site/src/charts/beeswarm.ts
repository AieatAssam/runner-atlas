// One row per label per metric, every sample a dot. Dots dodge vertically, deterministically, so none overlap.
import { axisBottom } from 'd3-axis';
import { scaleLinear } from 'd3-scale';
import { select } from 'd3-selection';
import type { BenchmarksRollup, MetricId } from '../../../shared/types/rollups.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { chartWidth, chartWrap, count, emptyNote, fixed, headCaption, labelColor, metricName, tickCount, ZOOMED_NOTE, summaryTable, svgEl, svgFor, svgText, tooltip } from './_axis.ts';

type PointKey = 'single' | 'multi' | 'write' | 'mem';
// The beeswarm carries only these four metrics; the others have no per-sample columns.
const COLUMN: Partial<Record<MetricId, PointKey>> = { singleCoreScore: 'single', multiCoreScore: 'multi', seqWriteMBs: 'write', memBandwidthGBs: 'mem' };
const ROW_H = 34;
const DOT_R = 2.6;
const LEFT = 120;
const RIGHT = 16;

// Places each value at the smallest vertical offset that keeps it clear of earlier dots in the row, within +-limit.
// Inputs are pixel x positions in ascending order. Offsets try 0, +step, -step, +2 step, ...; when every slot within the
// row is taken, the dot goes to the slot whose nearest neighbour is farthest away, so a dense row overlaps instead of spilling.
function dodge(xs: number[], step: number, limit: number): number[] {
  const placed: Array<{ x: number; y: number }> = [];
  const slots: number[] = [0];
  for (let k = 1; k * step <= limit; k++) slots.push(k * step, -k * step);
  return xs.map((x) => {
    const near = placed.filter((p) => Math.abs(p.x - x) < 2 * DOT_R);
    let best = 0;
    let bestGap = -1;
    for (const y of slots) {
      const gap = Math.min(Infinity, ...near.map((p) => (p.x - x) ** 2 + (p.y - y) ** 2));
      if (gap >= (2 * DOT_R) ** 2) { best = y; break; }
      if (gap > bestGap) { bestGap = gap; best = y; }
    }
    placed.push({ x, y: best });
    return best;
  });
}

function render(ctx: RenderContext, data: BenchmarksRollup): void {
  const { tokens } = ctx;
  const width = chartWidth(ctx);
  const wrap = chartWrap(ctx);
  const rows: string[][] = [];
  const labels = data.points.labels;
  const beeswarm = data.beeswarm;

  for (const metric of data.metrics) {
    const key = COLUMN[metric.id];
    const name = metricName(metric.id);
    if (!key || !metric.domain || beeswarm.length === 0) continue;
    const values = data.points[key];
    const present = labels.map((_, li) => li).filter((li) => beeswarm.some((i) => data.points.label[i] === li));
    if (present.length === 0) continue;

    const height = 30 + present.length * ROW_H + 26;
    const svg = svgFor(wrap, width, height, `${name}, one row per label, a dot per sample, in ${metric.unit}.`);
    svgText(svg, 0, 14, `${name}, ${metric.unit}`, { fill: tokens.ink, 'font-weight': 600 });
    const x = scaleLinear().domain(metric.domain).range([LEFT, width - RIGHT]).clamp(true);

    present.forEach((li, row) => {
      const label = labels[li] ?? '';
      const baseline = 30 + row * ROW_H + ROW_H / 2;
      const colour = labelColor(tokens, label);
      const idx = beeswarm.filter((i) => data.points.label[i] === li).sort((a, b) => (values[a] ?? 0) - (values[b] ?? 0));
      const offsets = dodge(idx.map((i) => x(values[i] ?? 0)), DOT_R * 2, ROW_H / 2 - DOT_R);
      const group = (data.byLabel[metric.id] ?? []).find((g) => g.label === label);
      // The row summary sits behind its dots as a sibling, never around them, so no focusable mark nests in another.
      const rowHit = svgEl('rect', { x: LEFT, y: baseline - ROW_H / 2, width: width - LEFT - RIGHT, height: ROW_H, fill: 'none', 'pointer-events': 'all' });
      svg.append(rowHit);
      tooltip(ctx, wrap, rowHit, `${label}, ${name}: median ${group ? `${fixed(group.q.p50, 1)} ${metric.unit}` : 'not measured'}, n = ${count(group?.n ?? 0)} samples, ${count(idx.length)} drawn`);
      idx.forEach((i, k) => {
        const dot = svgEl('circle', { cx: x(values[i] ?? 0), cy: baseline + (offsets[k] ?? 0), r: DOT_R, fill: colour, 'fill-opacity': 0.75 });
        svg.append(dot);
        tooltip(ctx, wrap, dot, `${label}, ${name}: ${fixed(values[i] ?? 0, 1)} ${metric.unit}, n = 1 sample`);
      });
      svgText(svg, LEFT - 8, baseline + 4, label, { 'text-anchor': 'end', fill: tokens.ink2 });
      if (group) rows.push([name, label, count(group.n), fixed(group.q.p25, 1), fixed(group.q.p50, 1), fixed(group.q.p75, 1)]);
    });

    const axis = svgEl<SVGGElement>('g', { transform: `translate(0,${height - 26})` });
    svg.append(axis);
    select(axis).call(axisBottom(x).ticks(tickCount(width - LEFT - RIGHT)));
  }

  if (rows.length === 0) emptyNote(wrap, 'No samples with all four benchmarks yet.');
  summaryTable(wrap, 'Runs by label: quartiles per metric', ['Metric', 'Label', 'Samples', 'p25', 'p50', 'p75'], rows);
}

export default {
  panel: 'beeswarm',
  caption: (data: BenchmarksRollup) => headCaption(data, ZOOMED_NOTE),
  render,
} satisfies ChartModule<BenchmarksRollup>;
