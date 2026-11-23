// Weekday and hour-of-day effects from a two-way median polish, with 95% bootstrap intervals; then the autocorrelation of delay by lag.
import { scaleLinear } from 'd3-scale';
import type { SeasonalityRollup } from '../../../shared/types/rollups.ts';
import { WEEKDAYS } from '../lib/format.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { chartWidth, chartWrap, count, emptyNote, fixed, headCaption, metricName, METRIC_UNITS, summaryTable, svgEl, svgFor, svgText, tooltip } from './_axis.ts';

type Kind = 'totalDelaySec' | 'singleCoreScore';
interface Row { label: string; tick: string | null; n: number; effect: number | null; ci95: [number, number] | null }

const EFFECT_H = 200;
const ACF_H = 160;
const PAD = { top: 16, right: 10, bottom: 26, left: 56 };

function show(v: number): string {
  return fixed(v, 1);
}

function describe(kind: Kind, r: Row): string {
  const counted = kind === 'totalDelaySec' ? 'runs' : 'samples';
  const unit = METRIC_UNITS[kind];
  if (r.effect === null) return `${r.label}: n = ${count(r.n)} ${counted}, not enough to estimate`;
  const interval = r.ci95 === null ? '' : ` (95% interval ${show(r.ci95[0])} to ${show(r.ci95[1])} ${unit})`;
  return `${r.label}: effect ${r.effect > 0 ? '+' : ''}${show(r.effect)} ${unit}${interval}, n = ${count(r.n)} ${counted}`;
}

function effectBars(ctx: RenderContext, kind: Kind, title: string, rows: Row[]): void {
  const { tokens } = ctx;
  const width = chartWidth(ctx);
  const wrap = chartWrap(ctx);
  const tableRows = rows.map((r) => [
    r.label,
    count(r.n),
    r.effect === null ? 'not estimated' : show(r.effect),
    r.ci95 === null ? 'not computed' : `${show(r.ci95[0])} to ${show(r.ci95[1])}`,
  ]);

  if (rows.every((r) => r.effect === null)) {
    emptyNote(wrap, `${title}: not enough runs in any slot yet.`);
  } else {
    const svg = svgFor(wrap, width, EFFECT_H, `${title}: centred effect on ${metricName(kind)} with 95% intervals.`);
    const innerW = width - PAD.left - PAD.right;
    const innerH = EFFECT_H - PAD.top - PAD.bottom;
    const edges: number[] = [0];
    for (const r of rows) {
      if (r.effect !== null) edges.push(r.effect);
      if (r.ci95 !== null) edges.push(r.ci95[0], r.ci95[1]);
    }
    const lo = Math.min(...edges);
    const hi = Math.max(...edges);
    const y = scaleLinear().domain([lo, hi > lo ? hi : lo + 1]).nice().range([PAD.top + innerH, PAD.top]);
    const step = innerW / rows.length;
    const barW = Math.min(24, Math.max(2, step * 0.6));
    const cx = (i: number): number => PAD.left + i * step + step / 2;

    svgText(svg, 0, 11, `${title}, ${METRIC_UNITS[kind]}`, { fill: tokens.ink, 'font-weight': 600 });
    for (const v of y.ticks(4)) {
      svg.append(svgEl('line', { x1: PAD.left, x2: PAD.left + innerW, y1: y(v), y2: y(v), stroke: tokens.rule, 'stroke-width': 1 }));
      svgText(svg, PAD.left - 6, y(v) + 4, show(v), { 'text-anchor': 'end', fill: tokens.muted });
    }
    svg.append(svgEl('line', { x1: PAD.left, x2: PAD.left + innerW, y1: y(0), y2: y(0), stroke: tokens.ink2, 'stroke-width': 0.75 }));

    rows.forEach((r, i) => {
      const group = svgEl('g');
      // Hit area spans the plot height, so a slot with no estimate still takes the pointer.
      group.append(svgEl('rect', { x: cx(i) - step / 2, y: PAD.top, width: step, height: innerH, fill: 'none', 'pointer-events': 'all' }));
      if (r.effect !== null) {
        const v = r.effect;
        // Diverging: cobalt is faster or earlier, copper slower or later. More delay is slower; a higher score is faster.
        const slower = kind === 'totalDelaySec' ? v >= 0 : v < 0;
        group.append(svgEl('rect', {
          x: cx(i) - barW / 2, y: Math.min(y(0), y(v)), width: barW, height: Math.abs(y(v) - y(0)),
          fill: slower ? tokens.diverging.high : tokens.diverging.low,
        }));
      }
      if (r.ci95 !== null) {
        const [a, b] = r.ci95;
        group.append(svgEl('line', { x1: cx(i), x2: cx(i), y1: y(a), y2: y(b), stroke: tokens.ink, 'stroke-width': 1 }));
        group.append(svgEl('line', { x1: cx(i) - 3, x2: cx(i) + 3, y1: y(a), y2: y(a), stroke: tokens.ink, 'stroke-width': 1 }));
        group.append(svgEl('line', { x1: cx(i) - 3, x2: cx(i) + 3, y1: y(b), y2: y(b), stroke: tokens.ink, 'stroke-width': 1 }));
      }
      svg.append(group);
      tooltip(ctx, wrap, group, describe(kind, r));
      if (r.tick !== null) svgText(svg, cx(i), EFFECT_H - 8, r.tick, { 'text-anchor': 'middle', fill: tokens.muted });
    });
  }

  summaryTable(wrap, `${title}: effects`, ['Slot', 'n', 'Effect', '95% interval'], tableRows);
}

function acfStems(ctx: RenderContext, title: string, values: Array<number | null>, tickEvery: number, lagUnit: 'day' | 'hour'): void {
  const { tokens } = ctx;
  const width = chartWidth(ctx);
  const wrap = chartWrap(ctx);
  const rows = values.map((v, i) => [`${i + 1} ${lagUnit}${i ? 's' : ''}`, v === null ? 'not enough pairs' : fixed(v, 2)]);

  if (values.every((v) => v === null)) {
    emptyNote(wrap, `${title}: not enough pairs yet, needs at least 10 per lag.`);
  } else {
    const svg = svgFor(wrap, width, ACF_H, `${title}: autocorrelation of total start delay by lag, ${values.length} lags.`);
    const innerW = width - PAD.left - PAD.right;
    const innerH = ACF_H - PAD.top - PAD.bottom;
    const y = scaleLinear().domain([-1, 1]).range([PAD.top + innerH, PAD.top]);
    const step = innerW / values.length;
    const cx = (i: number): number => PAD.left + (i + 0.5) * step;

    svgText(svg, 0, 11, title, { fill: tokens.ink, 'font-weight': 600 });
    for (const v of [-1, -0.5, 0, 0.5, 1]) {
      svg.append(svgEl('line', { x1: PAD.left, x2: PAD.left + innerW, y1: y(v), y2: y(v), stroke: v === 0 ? tokens.ink2 : tokens.rule, 'stroke-width': v === 0 ? 0.75 : 1 }));
      svgText(svg, PAD.left - 6, y(v) + 4, fixed(v, 1), { 'text-anchor': 'end', fill: tokens.muted });
    }
    values.forEach((v, i) => {
      if (v === null) return;
      const stem = svgEl('g');
      stem.append(svgEl('rect', { x: cx(i) - step / 2, y: PAD.top, width: step, height: innerH, fill: 'none', 'pointer-events': 'all' }));
      stem.append(svgEl('line', { x1: cx(i), x2: cx(i), y1: y(0), y2: y(v), stroke: tokens.ink2, 'stroke-width': Math.min(2, Math.max(1, step * 0.5)) }));
      svg.append(stem);
      tooltip(ctx, wrap, stem, `Lag ${i + 1} ${lagUnit}${i ? 's' : ''}: autocorrelation ${fixed(v, 2)}`);
      if ((i + 1) % tickEvery === 0) svgText(svg, cx(i), ACF_H - 8, `${i + 1}`, { 'text-anchor': 'middle', fill: tokens.muted });
    });
  }

  summaryTable(wrap, `${title}: autocorrelation by lag`, ['Lag', 'Autocorrelation'], rows);
}

function weekdayRows(data: SeasonalityRollup, kind: Kind): Row[] {
  return data.weekdayEffect[kind].map((r) => ({
    label: WEEKDAYS[r.weekday] ?? `Day ${r.weekday}`,
    tick: WEEKDAYS[r.weekday]?.slice(0, 3) ?? null,
    n: r.n, effect: r.effect, ci95: r.ci95,
  }));
}

function hourRows(data: SeasonalityRollup, kind: Kind): Row[] {
  return data.diurnalEffect[kind].map((r) => {
    const hh = String(r.hourUtc).padStart(2, '0');
    return { label: `${hh}:00 UTC`, tick: r.hourUtc % 3 === 0 ? hh : null, n: r.n, effect: r.effect, ci95: r.ci95 };
  });
}

function render(ctx: RenderContext, data: SeasonalityRollup): void {
  for (const kind of ['totalDelaySec', 'singleCoreScore'] as const) {
    const name = metricName(kind);
    effectBars(ctx, kind, `${name} by weekday`, weekdayRows(data, kind));
    effectBars(ctx, kind, `${name} by hour of day`, hourRows(data, kind));
  }
  acfStems(ctx, 'Daily total start delay', data.acf.dailyTotalDelay, 2, 'day');
  acfStems(ctx, 'Hourly total start delay', data.acf.hourlyTotalDelay, 24, 'hour');
}

export default {
  panel: 'seasonality-effects',
  caption: (data: SeasonalityRollup) => headCaption(data, 'Centred effects from a two-way median polish'),
  render,
} satisfies ChartModule<SeasonalityRollup>;
