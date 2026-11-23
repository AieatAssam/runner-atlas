// Equirectangular land map with a graticule and one circle per region, sized by its samples.
// Used in the hero well and as the globe fallback, so it emits no element ids at all.
import { geoEquirectangular, geoGraticule10, geoPath } from 'd3-geo';
import { scaleSqrt } from 'd3-scale';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import landAtlas from 'world-atlas/land-110m.json' with { type: 'json' };
import type { RegionsRollup } from '../../../shared/types/rollups.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { firstClear, leaderTo, type Box, type Placement } from '../lib/labels.ts';
import { chartWidth, count, emptyNote, pct, summaryTable, svgEl, svgFor, svgText, chartWrap, tooltip, fixed } from './_axis.ts';

const land = feature(landAtlas as unknown as Topology, (landAtlas as unknown as Topology & { objects: { land: GeometryCollection } }).objects.land);

const CHAR_W = 6.7;
const LABEL_H = 12;
const MIN_SPAN_LON = 60;
const DISPLACED = [16, 28, 40];

// Where a region name can go, nearest first: right, left, above, below the circle; then eight directions further out,
// each with a short leader back to the circle. A spot that clears nothing is dropped by the caller.
function spotsFor(x: number, y: number, r: number, w: number): Placement[] {
  const h = LABEL_H;
  const near: Box[] = [
    { left: x + r + 3, top: y - h / 2, width: w, height: h },
    { left: x - r - 3 - w, top: y - h / 2, width: w, height: h },
    { left: x - w / 2, top: y - r - 3 - h, width: w, height: h },
    { left: x - w / 2, top: y + r + 3, width: w, height: h },
  ];
  const spots: Placement[] = near.map((box) => ({ box, leader: null }));
  for (const d of DISPLACED) {
    for (let k = 0; k < 8; k++) {
      const angle = (k * Math.PI) / 4;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      // The box's near edge, not its centre, sits r + d out, so a wide name never lies back over its own circle.
      const cx = x + dx * (r + d + w / 2);
      const cy = y + dy * (r + d + h / 2);
      const box = { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
      spots.push({ box, leader: leaderTo({ x, y }, box) });
    }
  }
  return spots;
}

// The sampled regions with a margin, at least 60 degrees wide and 2:1, or null for the whole world
// (no regions, or regions spread over more than half the globe). Corners as a MultiPoint, so no ring winding.
function frame(regions: RegionsRollup['regions']): { type: 'MultiPoint'; coordinates: Array<[number, number]> } | null {
  if (regions.length === 0) return null;
  const lons = regions.map((r) => r.lon);
  const lats = regions.map((r) => r.lat);
  const cx = (Math.min(...lons) + Math.max(...lons)) / 2;
  const cy = (Math.min(...lats) + Math.max(...lats)) / 2;
  const span = Math.max(MIN_SPAN_LON, (Math.max(...lons) - Math.min(...lons)) * 1.5, (Math.max(...lats) - Math.min(...lats)) * 3);
  if (span >= 180) return null;
  const half = span / 2;
  const west = Math.max(-180, Math.min(180 - span, cx - half));
  const south = Math.max(-90, Math.min(90 - half, cy - half / 2));
  return { type: 'MultiPoint', coordinates: [[west, south], [west + span, south + half]] };
}

function caption(data: RegionsRollup) {
  const unknown = data.unknown.samples;
  return {
    n: data.n.samples,
    unit: 'samples' as const,
    runs: data.n.runs,
    range: data.range,
    note: unknown > 0 ? `${count(unknown)} samples without a region` : undefined,
  };
}

function render(ctx: RenderContext, data: RegionsRollup): void {
  const width = chartWidth(ctx);
  const height = Math.max(200, Math.round(width * 0.5));
  const wrap = chartWrap(ctx);
  const summary = data.regions.length
    ? `Map of ${data.regions.length} sampled regions, with circles sized by samples.`
    : 'Map with no sampled regions yet.';
  const svg = svgFor(wrap, width, height, summary);

  const projection = geoEquirectangular();
  const view = frame(data.regions);
  if (view) {
    projection.fitExtent([[8, 8], [width - 8, height - 8]], view);
    svg.classList.add('chart__svg--clip');
  } else {
    projection.fitExtent([[4, 4], [width - 4, height - 4]], land);
  }
  const path = geoPath(projection);

  svg.append(svgEl('path', { d: path(geoGraticule10()) ?? '', fill: 'none', stroke: ctx.tokens.rule, 'stroke-width': 0.5 }));
  svg.append(svgEl('path', { d: path(land) ?? '', fill: ctx.tokens.paper2, stroke: ctx.tokens.ink2, 'stroke-width': 0.6 }));

  const max = Math.max(0, ...data.regions.map((r) => r.samples));
  const radius = scaleSqrt().domain([0, max || 1]).range([3, Math.max(8, Math.min(20, width / 30))]);
  const sorted = [...data.regions].sort((a, b) => b.samples - a.samples);
  const marks = sorted.flatMap((region) => {
    const point = projection([region.lon, region.lat]);
    return point ? [{ region, x: point[0], y: point[1], r: radius(region.samples) }] : [];
  });

  // Leaders sit under the circles, circles under the labels. Every circle is an obstacle for every label, and a
  // region's own circle is skipped (its label may start inside it).
  const leaders = svgEl('g');
  const circles = svgEl('g');
  const labels = svgEl('g');
  for (const m of marks) {
    const circle = svgEl('circle', { cx: m.x, cy: m.y, r: m.r, fill: ctx.tokens.accent, 'fill-opacity': 0.55, stroke: ctx.tokens.paper, 'stroke-width': 1 });
    circles.append(circle);
    tooltip(ctx, wrap, circle, `${m.region.region}: n = ${count(m.region.samples)} samples, ${pct(m.region.share)} of the survey`);
  }
  const obstacles: Box[] = marks.map((m) => ({ left: m.x - m.r, top: m.y - m.r, width: 2 * m.r, height: 2 * m.r }));
  const bounds = { width, height, pad: 2, gap: 2 };
  const placed: Placement[] = [];
  // Largest regions are placed first. A name with no clear spot is dropped; the table and tooltip still carry it.
  for (const m of marks) {
    const anchor = { x: m.x, y: m.y };
    const candidates = spotsFor(m.x, m.y, m.r, m.region.region.length * CHAR_W);
    const spot = firstClear(candidates, anchor, { ...bounds, strict: true }, placed, obstacles)
      ?? firstClear(candidates, anchor, { ...bounds, strict: false }, placed, obstacles);
    if (!spot) continue;
    placed.push(spot);
    const l = spot.leader;
    if (l) leaders.append(svgEl('line', { x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, stroke: ctx.tokens.ink2, 'stroke-width': 0.6 }));
    svgText(labels, spot.box.left, spot.box.top + 10, m.region.region, { fill: ctx.tokens.ink, class: 'chart__halo', 'aria-hidden': 'true' });
  }
  svg.append(leaders, circles, labels);

  if (data.regions.length === 0) emptyNote(wrap, 'No region is placed yet. The map shows land only.');
  summaryTable(wrap, 'Samples by region', ['Region', 'Samples', 'Share', 'Placed by', 'Median time to first byte', 'Median start delay'],
    data.regions.map((r) => [
      r.region,
      count(r.samples),
      pct(r.share),
      r.method,
      r.ttfbMedianMs === null ? 'not measured' : `${fixed(r.ttfbMedianMs, 0)} ms`,
      r.totalDelayMedianSec === null ? 'not measured' : `${fixed(r.totalDelayMedianSec, 0)} s`,
    ]));
}

export default { panel: 'region-map', caption, render } satisfies ChartModule<RegionsRollup>;
