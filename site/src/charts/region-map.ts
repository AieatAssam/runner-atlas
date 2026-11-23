// Equirectangular land map with a graticule and one circle per region, sized by its samples.
// Used in the hero well and as the globe fallback, so it emits no element ids at all.
import { geoEquirectangular, geoGraticule10, geoPath } from 'd3-geo';
import { scaleSqrt } from 'd3-scale';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import landAtlas from 'world-atlas/land-110m.json' with { type: 'json' };
import type { RegionsRollup } from '../../../shared/types/rollups.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { chartWidth, count, emptyNote, pct, summaryTable, svgEl, svgFor, svgText, chartWrap, tooltip, fixed } from './_axis.ts';

const land = feature(landAtlas as unknown as Topology, (landAtlas as unknown as Topology & { objects: { land: GeometryCollection } }).objects.land);

const CHAR_W = 6.7;
const MIN_SPAN_LON = 60;
interface Box { x: number; y: number; w: number; h: number }

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
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
  const placed: Box[] = [];
  const labels = svgEl('g');
  for (const region of sorted) {
    const point = projection([region.lon, region.lat]);
    if (!point) continue;
    const [x, y] = point;
    const r = radius(region.samples);
    const circle = svgEl('circle', { cx: x, cy: y, r, fill: ctx.tokens.accent, 'fill-opacity': 0.55, stroke: ctx.tokens.paper, 'stroke-width': 1 });
    svg.append(circle);
    tooltip(ctx, wrap, circle, `${region.region}: n = ${count(region.samples)} samples, ${pct(region.share)} of the survey`);
    // Largest regions are labelled first; a label that would collide tries the other side, then gives way (the table and tooltip keep it).
    const w = region.region.length * CHAR_W;
    const spots: Box[] = [
      { x: x + r + 3, y: y - 7, w, h: 12 },
      { x: x - r - 3 - w, y: y - 7, w, h: 12 },
      { x: x - w / 2, y: y - r - 15, w, h: 12 },
      { x: x - w / 2, y: y + r + 3, w, h: 12 },
    ];
    const spot = spots.find((b) => b.x >= 0 && b.x + b.w <= width && b.y >= 0 && b.y + b.h <= height && !placed.some((o) => overlaps(o, b)));
    if (!spot) continue;
    placed.push(spot);
    svgText(labels, spot.x, spot.y + 10, region.region, { fill: ctx.tokens.ink, class: 'chart__halo', 'aria-hidden': 'true' });
  }
  svg.append(labels);

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
