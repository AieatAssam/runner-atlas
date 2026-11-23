// 2D fallback for the 3D point cloud: memory bandwidth against single core score, dot size by sequential write.
// Dots are not focusable (up to 2000 of them); the focusable marks are the per-label medians.
import { scaleLinear, scaleSqrt } from 'd3-scale';
import type { BenchmarksRollup } from '../../../shared/types/rollups.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { chartWidth, chartWrap, count, emptyNote, fixed, labelColor, metricName, tickCount, ZOOMED_NOTE, summaryTable, svgEl, svgFor, svgText, tooltip } from './_axis.ts';

const HEIGHT = 300;
const PAD = { top: 16, right: 16, bottom: 36, left: 52 };

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function render(ctx: RenderContext, data: BenchmarksRollup): void {
  const { tokens } = ctx;
  const width = chartWidth(ctx);
  const wrap = chartWrap(ctx);
  const { points } = data;
  const total = points.id.length;
  const unitOf = (id: string): string => data.metrics.find((m) => m.id === id)?.unit ?? '';
  const xLabel = `${metricName('memBandwidthGBs')}, ${unitOf('memBandwidthGBs')}`;
  const yLabel = `${metricName('singleCoreScore')}, ${unitOf('singleCoreScore')}`;

  if (total === 0) {
    svgFor(wrap, width, HEIGHT, 'Memory bandwidth against single core score: no samples yet.');
    emptyNote(wrap, 'No samples with all four benchmarks yet.');
    summaryTable(wrap, 'Samples by label', ['Label', 'Samples', 'Median single core score', 'Median memory bandwidth', 'Median sequential write'], []);
    return;
  }

  const svg = svgFor(wrap, width, HEIGHT, `Scatter of ${count(total)} samples: memory bandwidth against single core score, dot size by sequential write.`);
  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = scaleLinear().domain(extent(points.mem)).nice().range([PAD.left, PAD.left + innerW]);
  const y = scaleLinear().domain(extent(points.single)).nice().range([PAD.top + innerH, PAD.top]);
  const r = scaleSqrt().domain(extent(points.write)).range([1.2, 3.4]);

  // Ticks and axis lines are drawn as plain SVG so the marks, not d3-axis, carry the colour tokens.
  for (const v of y.ticks(tickCount(innerH))) {
    svg.append(svgEl('line', { x1: PAD.left, x2: PAD.left + innerW, y1: y(v), y2: y(v), stroke: tokens.rule, 'stroke-width': 1 }));
    svgText(svg, PAD.left - 6, y(v) + 4, fixed(v, 0), { 'text-anchor': 'end', fill: tokens.muted });
  }
  for (const v of x.ticks(tickCount(innerW))) {
    svgText(svg, x(v), HEIGHT - PAD.bottom + 16, fixed(v, 0), { 'text-anchor': 'middle', fill: tokens.muted });
  }
  svgText(svg, PAD.left + innerW, HEIGHT - 4, xLabel, { 'text-anchor': 'end', fill: tokens.ink2 });
  svgText(svg, PAD.left, PAD.top - 4, yLabel, { fill: tokens.ink2 });

  const labelOf = (i: number): number => points.label[i] ?? 0;
  const nameOf = (i: number): string => points.labels[labelOf(i)] ?? '';
  const mem = unitOf('memBandwidthGBs');
  const single = unitOf('singleCoreScore');
  const write = unitOf('seqWriteMBs');
  // Dots are drawn left to right, so arrow keys walk them in x order.
  const order = [...Array(total).keys()].sort((a, b) => (points.mem[a] ?? 0) - (points.mem[b] ?? 0));
  for (const i of order) {
    const dot = svgEl('circle', {
      cx: x(points.mem[i] ?? 0), cy: y(points.single[i] ?? 0), r: r(points.write[i] ?? 0),
      fill: labelColor(tokens, nameOf(i)), 'fill-opacity': 0.55,
    });
    svg.append(dot);
    tooltip(ctx, wrap, dot, `${nameOf(i)}, ${points.date[i] ?? ''}: single core ${fixed(points.single[i] ?? 0, 1)} ${single}, memory ${fixed(points.mem[i] ?? 0, 1)} ${mem}, write ${fixed(points.write[i] ?? 0, 0)} ${write}, n = 1 sample`);
  }

  const rows: string[][] = [];
  points.labels.forEach((label, li) => {
    const idx = [...Array(total).keys()].filter((i) => labelOf(i) === li);
    if (idx.length === 0) return;
    const mx = median(idx.map((i) => points.mem[i] ?? 0));
    const sy = median(idx.map((i) => points.single[i] ?? 0));
    const sw = median(idx.map((i) => points.write[i] ?? 0));
    const mark = svgEl('circle', { cx: x(mx), cy: y(sy), r: 6, fill: labelColor(tokens, label), stroke: tokens.ink, 'stroke-width': 1.5 });
    svg.append(mark);
    tooltip(ctx, wrap, mark, `${label} median: single core ${fixed(sy, 1)} ${single}, memory ${fixed(mx, 1)} ${mem}, n = ${count(idx.length)} samples`);
    rows.push([label, count(idx.length), fixed(sy, 1), fixed(mx, 1), fixed(sw, 0)]);
  });

  summaryTable(wrap, 'Samples by label: medians', ['Label', 'Samples', 'Median single core score', 'Median memory bandwidth', 'Median sequential write'], rows);
}

function extent(xs: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of xs) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi === lo ? lo + 1 : hi] : [0, 1];
}

export default {
  panel: 'pointcloud-2d',
  // points keeps samples with all four benchmarks, so n counts those samples.
  caption: (data: BenchmarksRollup) => ({ n: data.points.id.length, unit: 'samples' as const, range: data.range, note: ZOOMED_NOTE }),
  render,
} satisfies ChartModule<BenchmarksRollup>;
