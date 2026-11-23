// Each metric as a small multiple: the 7 day rolling 10th to 90th percentile band, the rolling median as the line,
// and the daily median as a thin trace. Each UTC day is a mark (hover column, arrow keys walk the days).
import { scaleLinear } from 'd3-scale';
import { area, line } from 'd3-shape';
import type { MetricId, SeasonalityRollup } from '../../../shared/types/rollups.ts';
import { formatDuration } from '../lib/format.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { chartWidth, chartWrap, count, emptyNote, fixed, headCaption, metricName, METRIC_UNITS, ZOOMED_NOTE, summaryTable, svgEl, svgFor, svgText, tooltip } from './_axis.ts';

type Key = MetricId | 'totalDelaySec';
const KEYS: Key[] = ['totalDelaySec', 'singleCoreScore', 'multiCoreScore', 'seqWriteMBs', 'seqReadMBs', 'memBandwidthGBs', 'netTtfbMs', 'netMbps'];
const HEIGHT = 140;
const PAD = { top: 28, right: 8, bottom: 22, left: 56 };

function show(key: Key, v: number): string {
  return key === 'totalDelaySec' ? formatDuration(v) : fixed(v, 1);
}

function lastIndex(values: Array<number | null>): number {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
  return -1;
}

function band(ctx: RenderContext, data: SeasonalityRollup, key: Key, width: number): void {
  const { tokens } = ctx;
  const wrap = chartWrap(ctx);
  const d = data.daily[key];
  const n = data.days.length;
  const idx = data.days.map((_, i) => i);
  const name = metricName(key);

  if (lastIndex(d.p50) < 0) {
    emptyNote(wrap, `${name}: no day with 20 or more samples yet.`);
    return;
  }

  const unit = key === 'totalDelaySec' ? '' : `, ${METRIC_UNITS[key]}`;
  const svg = svgFor(wrap, width, HEIGHT, `${name}: 7 day rolling median with its 10th to 90th percentile band, ${n} UTC days.`);
  svgText(svg, 0, 14, `${name}${unit}`, { fill: tokens.ink, 'font-weight': 600 });
  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = scaleLinear().domain([0, Math.max(1, n - 1)]).range([PAD.left, PAD.left + innerW]);
  const edges: number[] = [];
  for (const v of [...d.roll7.p10, ...d.roll7.p90, ...d.p50]) if (v !== null) edges.push(v);
  const lo = Math.min(...edges);
  const hi = Math.max(...edges);
  const y = scaleLinear().domain([lo, hi > lo ? hi : lo + 1]).nice().range([PAD.top + innerH, PAD.top]);

  for (const v of y.ticks(3)) {
    svg.append(svgEl('line', { x1: PAD.left, x2: PAD.left + innerW, y1: y(v), y2: y(v), stroke: tokens.rule, 'stroke-width': 1 }));
    svgText(svg, PAD.left - 6, y(v) + 4, show(key, v), { 'text-anchor': 'end', fill: tokens.muted });
  }
  svgText(svg, PAD.left, HEIGHT - 6, data.days[0]?.slice(5) ?? '', { fill: tokens.muted });
  svgText(svg, PAD.left + innerW, HEIGHT - 6, data.days[n - 1]?.slice(5) ?? '', { 'text-anchor': 'end', fill: tokens.muted });

  const bandPath = area<number>()
    .defined((i) => d.roll7.p10[i] !== null && d.roll7.p90[i] !== null)
    .x((i) => x(i))
    .y0((i) => y(d.roll7.p10[i] ?? 0))
    .y1((i) => y(d.roll7.p90[i] ?? 0));
  svg.append(svgEl('path', { d: bandPath(idx) ?? '', fill: tokens.muted, 'fill-opacity': 0.22 }));

  const medianPath = line<number>()
    .defined((i) => d.p50[i] !== null)
    .x((i) => x(i))
    .y((i) => y(d.p50[i] ?? 0));
  svg.append(svgEl('path', { d: medianPath(idx) ?? '', fill: 'none', stroke: tokens.muted, 'stroke-width': 1 }));

  const rollPath = line<number>()
    .defined((i) => d.roll7.p50[i] !== null)
    .x((i) => x(i))
    .y((i) => y(d.roll7.p50[i] ?? 0));
  svg.append(svgEl('path', { d: rollPath(idx) ?? '', fill: 'none', stroke: tokens.ink, 'stroke-width': 2 }));

  // One mark per day, the full plot height so the pointer finds it easily.
  const colW = innerW / Math.max(1, n);
  const roll = (i: number): string => {
    const r = d.roll7;
    const p50 = r.p50[i] ?? null;
    return p50 === null ? '' : `, 7 day median ${show(key, p50)} (10th to 90th ${show(key, r.p10[i] ?? 0)} to ${show(key, r.p90[i] ?? 0)})`;
  };
  data.days.forEach((day, i) => {
    const p50 = d.p50[i] ?? null;
    const text = p50 === null
      ? `${day}: n = ${count(d.n[i] ?? 0)} samples, too few for a median${roll(i)}`
      : `${day}: median ${show(key, p50)}${roll(i)}, n = ${count(d.n[i] ?? 0)} samples`;
    const hit = svgEl('rect', { x: x(i) - colW / 2, y: PAD.top, width: colW, height: innerH, fill: 'none', 'pointer-events': 'all' });
    svg.append(hit);
    tooltip(ctx, wrap, hit, text);
  });
}

function render(ctx: RenderContext, data: SeasonalityRollup): void {
  const width = chartWidth(ctx);
  const rows: string[][] = [];

  for (const key of KEYS) band(ctx, data, key, width);

  for (const key of KEYS) {
    const latest = lastIndex(data.daily[key].p50);
    const trend = data.trend[key];
    const slope = trend.theilSenPerWeek === null ? 'not enough days' : `${fixed(trend.theilSenPerWeek, 2)} per week`;
    const interval = trend.ci95 === null ? 'not computed' : `${fixed(trend.ci95[0], 2)} to ${fixed(trend.ci95[1], 2)}`;
    rows.push([
      metricName(key),
      latest < 0 ? 'none' : data.days[latest] ?? '',
      latest < 0 ? 'not measured' : show(key, data.daily[key].p50[latest] ?? 0),
      slope,
      interval,
    ]);
  }

  const wrap = chartWrap(ctx);
  summaryTable(wrap, 'Daily medians and trend by metric', ['Metric', 'Latest day', 'Latest median', 'Trend (Theil-Sen)', 'Trend 95% interval'], rows);
}

export default {
  panel: 'seasonality-bands',
  caption: (data: SeasonalityRollup) => headCaption(data, ZOOMED_NOTE),
  render,
} satisfies ChartModule<SeasonalityRollup>;
