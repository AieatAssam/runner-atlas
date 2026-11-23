// Linux runners: CPU steal (x) against the z score of the benchmark (y). Dots are the runs; the OLS line and bucket medians sit on top.
import { scaleLinear } from 'd3-scale';
import type { NeighboursRollup } from '../../../shared/types/rollups.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { chartWidth, chartWrap, count, emptyNote, fixed, headCaption, summaryTable, svgEl, svgFor, svgText, tickCount, tooltip } from './_axis.ts';

const HEIGHT = 320;
const PAD = { top: 14, right: 16, bottom: 40, left: 48 };

function extent(xs: number[], fallback: [number, number]): [number, number] {
  if (xs.length === 0) return fallback;
  return [Math.min(...xs), Math.max(...xs)];
}

function note(data: NeighboursRollup): string {
  const o = data.overall;
  const rho = o.spearmanRho === null ? 'Spearman rho not computed yet' : `Spearman rho ${fixed(o.spearmanRho, 2)}`;
  return `Linux runners only. ${rho}.`;
}

function render(ctx: RenderContext, data: NeighboursRollup): void {
  const { tokens } = ctx;
  const width = chartWidth(ctx);
  const wrap = chartWrap(ctx);
  const { steal, z } = data.points;
  const svg = svgFor(wrap, width, HEIGHT, `Scatter of ${count(steal.length)} Linux samples: CPU steal against benchmark z score, with bucket medians.`);

  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const [, xHi] = extent(steal, [0, 1]);
  const x = scaleLinear().domain([0, xHi || 1]).nice().range([PAD.left, PAD.left + innerW]);
  const [zLo, zHi] = extent(z, [-1, 1]);
  const y = scaleLinear().domain([Math.min(zLo, -0.5), Math.max(zHi, 0.5)]).nice().range([PAD.top + innerH, PAD.top]);

  for (const v of y.ticks(tickCount(innerH, 5))) {
    svg.append(svgEl('line', { x1: PAD.left, x2: PAD.left + innerW, y1: y(v), y2: y(v), stroke: tokens.rule, 'stroke-width': 1 }));
    svgText(svg, PAD.left - 6, y(v) + 4, fixed(v, 1), { 'text-anchor': 'end', fill: tokens.muted });
  }
  for (const v of x.ticks(tickCount(innerW))) {
    svgText(svg, x(v), HEIGHT - PAD.bottom + 16, `${fixed(v, 1)}%`, { 'text-anchor': 'middle', fill: tokens.muted });
  }
  svgText(svg, PAD.left + innerW, HEIGHT - 4, 'CPU steal, %', { 'text-anchor': 'end', fill: tokens.ink2 });
  svgText(svg, PAD.left, PAD.top - 2, 'z score', { fill: tokens.ink2 });
  svg.append(svgEl('line', { x1: PAD.left, x2: PAD.left + innerW, y1: y(0), y2: y(0), stroke: tokens.ink2, 'stroke-width': 0.75 }));

  // Every run is a mark, drawn left to right so arrow keys walk them by steal.
  const { labels, label } = data.points;
  const order = [...steal.keys()].sort((a, b) => (steal[a] ?? 0) - (steal[b] ?? 0));
  const dots = svgEl('g');
  for (const i of order) {
    const dot = svgEl('circle', { cx: x(steal[i] ?? 0), cy: y(z[i] ?? 0), r: 1.6, fill: tokens.muted, 'fill-opacity': 0.4 });
    dots.append(dot);
    tooltip(ctx, wrap, dot, `${labels[label[i] ?? -1] ?? 'Linux run'}: steal ${fixed(steal[i] ?? 0, 2)}%, z ${fixed(z[i] ?? 0, 2)}, n = 1 sample`);
  }
  svg.append(dots);

  const o = data.overall;
  if (o.slope !== null && o.intercept !== null && steal.length > 0) {
    const x1 = x.domain()[0] ?? 0;
    const x2 = x.domain()[1] ?? 1;
    svg.append(svgEl('line', {
      x1: x(x1), x2: x(x2), y1: y(o.intercept + o.slope * x1), y2: y(o.intercept + o.slope * x2),
      stroke: tokens.ink, 'stroke-width': 1.5,
    }));
  }

  // Bucket medians sit on top of the runs and come after them in arrow order.
  const xMax = x.domain()[1] ?? 1;
  const rows: string[][] = [];
  for (const b of data.buckets) {
    if (b.n === 0) continue;
    const hi = b.hi ?? xMax;
    const mid = (b.lo + hi) / 2;
    const band = b.hi === null ? `${fixed(b.lo, 1)}% and above` : `${fixed(b.lo, 1)} to ${fixed(b.hi, 1)}%`;
    const text = `Steal ${band}: median z ${fixed(b.zMedian, 2)} (quartiles ${fixed(b.zP25, 2)} to ${fixed(b.zP75, 2)}), n = ${count(b.n)} samples`;
    const g = svgEl('g');
    g.append(svgEl('line', { x1: x(mid), x2: x(mid), y1: y(b.zP25), y2: y(b.zP75), stroke: tokens.accent, 'stroke-width': 2 }));
    g.append(svgEl('circle', { cx: x(mid), cy: y(b.zMedian), r: 5, fill: tokens.accent, stroke: tokens.paper, 'stroke-width': 1.5 }));
    svg.append(g);
    tooltip(ctx, wrap, g, text);
    rows.push([band, count(b.n), fixed(b.zMedian, 2), fixed(b.zP25, 2), fixed(b.zP75, 2)]);
  }

  summaryTable(wrap, 'Steal buckets', ['Steal', 'Samples', 'Median z', 'z p25', 'z p75'], rows);
  if (steal.length === 0) emptyNote(wrap, 'No Linux runs yet.');
}

export default {
  panel: 'neighbours-scatter',
  caption: (data: NeighboursRollup) => headCaption(data, note(data)),
  render,
} satisfies ChartModule<NeighboursRollup>;
