// Image share per label: one horizontal bar per UTC day (days run down the page), stacked to 100 percent.
// Change points are horizontal rules on their day, annotated with the shift at the right.
import { scaleLinear } from 'd3-scale';
import type { RolloutsRollup } from '../../../shared/types/rollups.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { chartWidth, chartWrap, count, emptyNote, headCaption, metricName, pct, summaryTable, svgEl, svgFor, svgText, tooltip } from './_axis.ts';

const LEFT = 46;
const RIGHT = 56;
const TOP = 24;
const AXIS_H = 20;
const MAX_PLOT_H = 270;

function render(ctx: RenderContext, data: RolloutsRollup): void {
  const { tokens } = ctx;
  const width = chartWidth(ctx);
  const wrap = chartWrap(ctx);
  const days = data.days;
  const n = days.length;
  const rows: string[][] = [];

  if (n === 0 || data.byLabel.length === 0) {
    emptyNote(wrap, 'No daily shares yet. The timeline starts once a label has samples.');
    summaryTable(wrap, 'Image share by label', ['Label', 'Image', 'First seen', 'Last seen', 'Latest share'], []);
    return;
  }

  // Bars are at most 24 px thick; a long survey packs its days into a fixed height, 1 px apart once there is room.
  const rowH = Math.min(24, Math.max(2, Math.floor(MAX_PLOT_H / n)));
  const gap = rowH >= 6 ? 2 : rowH >= 4 ? 1 : 0;
  const plotH = rowH * n;
  const x = scaleLinear().domain([0, 1]).range([LEFT, width - RIGHT]);
  const rowY = (d: number): number => TOP + d * rowH;
  // Ranked images step three places along the 7-step ramp (6, 3, 0, 4, 1, 5, 2), so neighbours in rank never look alike.
  const colourOf = (version: string, k: number): string =>
    version === 'other' ? tokens.muted : tokens.sequential[6 - ((k * 3) % 7)] ?? tokens.ink2;

  for (const group of data.byLabel) {
    const images = group.images;
    const legendTop = TOP + plotH + AXIS_H + 14;
    const height = legendTop + images.length * 14 + 4;
    const svg = svgFor(wrap, width, height, `${group.label}: runner image share for each of ${n} days, stacked to 100 percent.`);
    svgText(svg, 0, 14, group.label, { fill: tokens.ink, 'font-weight': 600 });

    images.forEach((img) => {
      const last = latest(img.share);
      rows.push([group.label, img.version, img.firstSeen, img.lastSeen, last === null ? 'not measured' : pct(last)]);
    });

    for (let d = 0; d < n; d++) {
      let cum = 0;
      const parts: string[] = [];
      images.forEach((img, k) => {
        const v = img.share[d];
        if (v === null || v === undefined || v <= 0) return;
        svg.append(svgEl('rect', { x: x(cum), y: rowY(d), width: Math.max(0, x(cum + v) - x(cum)), height: rowH - gap, fill: colourOf(img.version, k) }));
        parts.push(`${img.version === 'other' ? 'other versions' : img.version} ${pct(v)}`);
        cum += v;
      });
      const hit = svgEl('rect', { x: LEFT, y: rowY(d), width: width - LEFT - RIGHT, height: rowH, fill: 'none', 'pointer-events': 'all' });
      svg.append(hit);
      tooltip(ctx, wrap, hit, `${days[d]}, ${group.label}: ${parts.join(', ') || 'no samples'}`);
    }

    // Share axis along the bottom: 0, 50 and 100 percent.
    for (const v of [0, 0.5, 1]) {
      svgText(svg, x(v), TOP + plotH + 14, `${v * 100}%`, { 'text-anchor': v === 0 ? 'start' : v === 1 ? 'end' : 'middle', fill: tokens.muted });
    }
    // Day labels down the left, about six of them.
    const step = Math.max(1, Math.ceil(n / 6));
    for (let d = 0; d < n; d += step) {
      svgText(svg, LEFT - 6, rowY(d) + Math.min(rowH, 10) / 2 + 4, (days[d] ?? '').slice(5), { 'text-anchor': 'end', fill: tokens.muted });
    }

    // Change points for this label: a rule across its day and the shift at the right.
    for (const cp of data.changePoints.filter((c) => c.label === group.label)) {
      const d = days.indexOf(cp.date);
      if (d < 0) continue;
      const cy = rowY(d) + rowH / 2;
      const sign = cp.shiftPct > 0 ? '+' : '';
      const text = `${metricName(cp.metric)} ${sign}${cp.shiftPct.toFixed(1)}% on ${cp.date}${cp.nearImageEvent ? ', near an image change' : ''}`;
      const marker = svgEl('g');
      marker.append(svgEl('rect', { x: LEFT, y: cy - 5, width: width - LEFT, height: 10, fill: 'none', 'pointer-events': 'all' }));
      marker.append(svgEl('line', { x1: LEFT, x2: width - RIGHT + 4, y1: cy, y2: cy, stroke: tokens.warn, 'stroke-width': 2 }));
      svgText(marker, width - RIGHT + 8, cy + 4, `${sign}${cp.shiftPct.toFixed(1)}%`, { fill: tokens.ink });
      svg.append(marker);
      tooltip(ctx, wrap, marker, `${group.label}: ${text}, n = ${count(cp.before.n)} samples before and ${count(cp.after.n)} after`);
    }

    // Legend: one line per image, with its latest share.
    images.forEach((img, k) => {
      const yy = legendTop + k * 14;
      const last = latest(img.share);
      svg.append(svgEl('rect', { x: 0, y: yy - 8, width: 9, height: 9, fill: colourOf(img.version, k) }));
      svgText(svg, 16, yy, `${img.version === 'other' ? 'Other versions' : img.version}${last === null ? '' : `, latest ${pct(last)}`}`, { fill: tokens.ink2 });
    });
  }

  summaryTable(wrap, 'Image share by label', ['Label', 'Image', 'First seen', 'Last seen', 'Latest share'], rows);
}

function latest(share: Array<number | null>): number | null {
  for (let i = share.length - 1; i >= 0; i--) {
    const v = share[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

export default {
  panel: 'rollout-timeline',
  caption: (data: RolloutsRollup) => headCaption(data),
  render,
} satisfies ChartModule<RolloutsRollup>;
