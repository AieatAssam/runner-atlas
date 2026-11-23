import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { geoEquirectangular, geoGraticule, geoPath } from 'd3-geo';
import { mesh } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import land from 'world-atlas/land-110m.json' with { type: 'json' };

const topology = land as Topology<{ land: GeometryCollection }>;
export const project = geoEquirectangular().fitSize([1600, 800], { type: 'Sphere' });
const path = geoPath(project).digits(2);
const graticule = geoGraticule().step([15, 15]);
const grid = path(graticule());
const coast = path(mesh(topology, topology.objects.land));
assert(grid && coast, 'Expected graticule and Natural Earth coastline paths');

export const mapPaths = `<path class="graticule" d="${grid}"/>
  <path class="coast" d="${coast}"/>`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(new URL('../../site/assets/plate-graticule.svg', import.meta.url),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 800" aria-hidden="true">
  <g fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round">
    <g opacity=".42">${mapPaths.replace('class="coast"', 'class="coast" stroke-width="2"')}</g>
  </g>
</svg>
`);
}
