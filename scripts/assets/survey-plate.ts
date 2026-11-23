import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import regions from '../../aggregator/data/region-coords.json' with { type: 'json' };
import { mapPaths, project } from './plates.ts';
import { renderWebp } from './render-webp.ts';

const nodes = Object.values(regions).map(({ lon, lat }) => {
  const point = project([lon, lat]);
  assert(point, 'Expected a projected region coordinate');
  return point;
});
const points = [...new Map(nodes.map(point => [point.join(','), point])).values()];
const delaunayEdges = new Map<string, [number, number]>();

// The region set is small. Enumerate Delaunay triangles by their empty circumcircles.
for (let i = 0; i < points.length - 2; i++) {
  const [ax, ay] = points[i];
  for (let j = i + 1; j < points.length - 1; j++) {
    const bx = points[j][0] - ax;
    const by = points[j][1] - ay;
    for (let k = j + 1; k < points.length; k++) {
      const cx = points[k][0] - ax;
      const cy = points[k][1] - ay;
      const determinant = 2 * (bx * cy - by * cx);
      if (Math.abs(determinant) < 1e-8) continue;
      const b2 = bx * bx + by * by;
      const c2 = cx * cx + cy * cy;
      const x = (b2 * cy - c2 * by) / determinant;
      const y = (bx * c2 - cx * b2) / determinant;
      const radius2 = x * x + y * y;
      if (points.some(([px, py], index) => index !== i && index !== j && index !== k &&
        (px - ax - x) ** 2 + (py - ay - y) ** 2 < radius2 - 1e-8)) continue;
      for (const [a, b] of [[i, j], [i, k], [j, k]]) {
        delaunayEdges.set(`${a},${b}`, [a, b]);
      }
    }
  }
}
assert(delaunayEdges.size > points.length, 'Expected a triangulated region network');

export const drawnEdges = new Map(delaunayEdges);
const minAngle = 3 * Math.PI / 180;
for (const [node, [x, y]] of points.entries()) {
  while (true) {
    const incident = Array.from(drawnEdges).flatMap(([key, [a, b]]) => {
      if (a !== node && b !== node) return [];
      const [px, py] = points[a === node ? b : a];
      const dx = px - x;
      const dy = py - y;
      return [{ key, angle: Math.atan2(dy, dx), distance: Math.hypot(dx, dy) }];
    });
    const conflict = incident.flatMap((first, i) => incident.slice(i + 1)
      .filter(second => {
        const angle = Math.abs(first.angle - second.angle);
        return Math.min(angle, 2 * Math.PI - angle) < minAngle;
      })
      .map(second => first.distance > second.distance ? first.key : second.key))[0];
    if (!conflict) break;
    drawnEdges.delete(conflict);
  }
}

// Edge removal cannot create a new angle conflict or near-node pass.
for (const [key, [a, c]] of drawnEdges) {
  const [ax, ay] = points[a];
  const dx = points[c][0] - ax;
  const dy = points[c][1] - ay;
  const length = Math.hypot(dx, dy);
  const passesNode = points.some(([x, y], b) => {
    if (b === a || b === c) return false;
    const along = ((x - ax) * dx + (y - ay) * dy) / length;
    const perpendicular = Math.abs((x - ax) * dy - (y - ay) * dx) / length;
    return along > 0 && along < length && perpendicular < 3;
  });
  if (passesNode) drawnEdges.delete(key);
}

// Draw the antimeridian at both pixel centres instead of clipping one side.
const surveyMap = mapPaths.replace(/(class="graticule" d=")M0,[^M]+/, '$1M.5,0V800M1599.5,0V800');
const networkPath = Array.from(drawnEdges.values(), ([a, b]) => `M${points[a]}L${points[b]}`).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="800" viewBox="0 0 1600 800">
  <style>.graticule { stroke-width: 1; shape-rendering: crispEdges; }</style>
  <g fill="none" stroke="black" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
    ${surveyMap}
    <path d="${networkPath}"/>
  </g>
  <g fill="black">${nodes.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.2"/>`).join('')}</g>
</svg>`;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await renderWebp(svg, 1600, 800, new URL('../../site/assets/art-survey-plate.webp', import.meta.url));
}
