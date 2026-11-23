// USGS National Map 3DEP 1/3 arc-second DEM, tile n47w122 (public domain).
// https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/n47w122/USGS_13_n47w122.tif
// Source window (west, south, east, north, NAD83/EPSG:4269): -121.879, 46.796, -121.641, 46.904.
// Area-averaged to 180 × 120 samples, north to south, rounded to metres. Index interval: 200 m.
import assert from 'node:assert/strict';
import { contours } from 'd3-contour';
import { geoPath } from 'd3-geo';
import { renderWebp } from './render-webp.ts';
import grid from './rainier-elevation.json' with { type: 'json' };

const columns = 180;
const rows = 120;
const interval = 200;
assert(grid.length === rows && grid.every(row => row.length === columns && row.every(Number.isFinite)));
const elevations = grid.flat();
const levels = [];
const firstLevel = Math.ceil(Math.min(...elevations) / interval) * interval;
const maxElevation = Math.max(...elevations);
for (let level = firstLevel; level < maxElevation; level += interval) {
  levels.push(level);
}
const path = geoPath();
const isolines = contours().size([columns, rows]).thresholds(levels)(elevations);
const insetX = .9;
const insetY = .6;
const inside = ([x, y]: number[]) =>
  x >= insetX && x <= columns - insetX && y >= insetY && y <= rows - insetY;

function visibleRuns(ring: number[][]): number[][][] {
  if (path.area({ type: 'Polygon', coordinates: [ring] }) < 1) return [];
  const vertices = ring.slice(0, -1);
  // Boundary vertices are synthetic closures from marching squares.
  const pinched = vertices.some(([x, y], i) => inside(vertices[i]) &&
    vertices.slice(i + 3, vertices.length - Math.max(0, 2 - i)).some(
      ([otherX, otherY]) => inside([otherX, otherY]) &&
        Math.hypot(x - otherX, y - otherY) < .4,
    ),
  );
  if (pinched) return [];

  const outside = vertices.findIndex(vertex => !inside(vertex));
  if (outside === -1) return [ring];
  const ordered = [...vertices.slice(outside), ...vertices.slice(0, outside + 1)];
  const runs = [];
  let start = 0;
  for (let end = 1; end < ordered.length; end++) {
    if (inside(ordered[end])) continue;
    // Include the adjacent outside vertices so valid lines meet the crop edge.
    if (end - start >= 4) runs.push(ordered.slice(start, end + 1));
    start = end;
  }
  return runs;
}

const lines = isolines.flatMap(line => line.coordinates.flatMap(polygon => polygon.flatMap(visibleRuns)));
const width = 1200;
const height = 800;
// Inset just past the half-cell border where marching squares closes rings.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"
  viewBox="${insetX} ${insetY} ${columns - 2 * insetX} ${rows - 2 * insetY}">
  <path d="${path({ type: 'MultiLineString', coordinates: lines })}" fill="none" stroke="black"
    stroke-width="1.75" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
</svg>`;

await renderWebp(svg, width, height, new URL('../../site/assets/plate-contours.webp', import.meta.url));
