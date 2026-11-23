import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import regions from '../../aggregator/data/region-coords.json' with { type: 'json' };
import { drawnEdges } from './survey-plate.ts';

const scale = 1600 / 360;
const coordinates = new Set(Object.values(regions).map(({ lon, lat }) => `${lon},${lat}`));
const points = Array.from(coordinates, coordinate => {
  const [lon, lat] = coordinate.split(',').map(Number);
  return [800 + lon * scale, 400 - lat * scale];
});

// Each point constrains the centre of an empty circle through A and C to
// one side of a bound on their perpendicular bisector.
const delaunayEdges = new Set<string>();
for (const [a, [ax, ay]] of points.entries()) {
  for (let c = a + 1; c < points.length; c++) {
    const [cx, cy] = points[c];
    const mx = (ax + cx) / 2;
    const my = (ay + cy) / 2;
    const length = Math.hypot(cx - ax, cy - ay);
    const nx = (ay - cy) / length;
    const ny = (cx - ax) / length;
    let lower = -Infinity;
    let upper = Infinity;
    for (const [b, [bx, by]] of points.entries()) {
      if (b === a || b === c) continue;
      const signedDistance = (bx - mx) * nx + (by - my) * ny;
      const margin = (bx - mx) ** 2 + (by - my) ** 2 - (length / 2) ** 2;
      if (signedDistance > 1e-9) upper = Math.min(upper, margin / (2 * signedDistance));
      else if (signedDistance < -1e-9) lower = Math.max(lower, margin / (2 * signedDistance));
      else if (margin < 0) {
        lower = Infinity;
        break;
      }
    }
    if (lower !== Infinity && lower <= upper) delaunayEdges.add(`${a},${c}`);
  }
}
const neighbours = points.map(() => [] as number[]);
let minNodeToEdge = Infinity;
for (const [a, c] of drawnEdges.values()) {
  assert(delaunayEdges.has(`${Math.min(a, c)},${Math.max(a, c)}`), 'Drawn edge must be Delaunay');
  neighbours[a].push(c);
  neighbours[c].push(a);
  const [ax, ay] = points[a];
  const dx = points[c][0] - ax;
  const dy = points[c][1] - ay;
  for (const [b, [bx, by]] of points.entries()) {
    if (b === a || b === c) continue;
    const t = ((bx - ax) * dx + (by - ay) * dy) / (dx * dx + dy * dy);
    if (t <= 0 || t >= 1) continue;
    const distance = Math.hypot(bx - (ax + t * dx), by - (ay + t * dy));
    assert(distance >= 3, `Edge ${a},${c} passes ${distance} px from node ${b}`);
    minNodeToEdge = Math.min(minNodeToEdge, distance);
  }
}
assert(Number.isFinite(minNodeToEdge));
const minDegree = Math.min(...neighbours.map(list => list.length));
assert(minDegree >= 2);
let minAngle = 180;
for (const [node, list] of neighbours.entries()) {
  const [x, y] = points[node];
  const vectors = list.map(i => [points[i][0] - x, points[i][1] - y]);
  for (const [i, [ax, ay]] of vectors.entries()) {
    for (const [bx, by] of vectors.slice(i + 1)) {
      const cosine = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
      const angle = Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
      minAngle = Math.min(minAngle, angle);
    }
  }
}
assert(minAngle >= 3);
const reachable = new Set([0]);
for (const node of reachable) {
  for (const neighbour of neighbours[node]) reachable.add(neighbour);
}
assert.equal(points.length, 37);
assert.equal(reachable.size, points.length);
console.log('Survey graph', { delaunay: delaunayEdges.size, drawn: drawnEdges.size,
  reachable: reachable.size, minDegree, minAngle, minNodeToEdge });

const asset = (name: string) => new URL(`../../site/assets/${name}`, import.meta.url);
const emblem = readFileSync(asset('emblem.svg'), 'utf8');
const browser = await chromium.launch();

try {
  const page = await browser.newPage();
  const plates = await page.evaluate(async ({ contour, survey }) => {
    async function decode(source: string, width: number, height: number) {
      const image = new Image();
      image.src = 'data:image/webp;base64,' + source;
      await image.decode();
      if (image.width !== width || image.height !== height) throw new Error('Unexpected plate dimensions');
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, width, height);
      const alpha = new Uint8Array(width * height);
      for (let i = 0; i < alpha.length; i++) {
        if (data[4*i] || data[4*i + 1] || data[4*i + 2]) throw new Error('Expected black RGB');
        alpha[i] = data[4*i + 3];
      }
      return alpha;
    }

    const width = 1200;
    const height = 800;
    const alpha = await decode(contour, width, height);
    const visited = new Uint8Array(alpha.length);
    const queue = new Int32Array(alpha.length);
    let smallestInk = Infinity;
    let smallestHole = Infinity;
    for (let seed = 0; seed < alpha.length; seed++) {
      if (visited[seed]) continue;
      const ink = alpha[seed] >= 128;
      let touchesEdge = false;
      let length = 1;
      queue[0] = seed;
      visited[seed] = 1;
      for (let index = 0; index < length; index++) {
        const pixel = queue[index];
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        if (!x || !y || x === width - 1 || y === height - 1) touchesEdge = true;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            // Dual connectivity keeps diagonal ink bridges from opening a background hole.
            if ((!dx && !dy) || (!ink && dx && dy)) continue;
            if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
            const neighbour = pixel + dx + dy * width;
            if (visited[neighbour] || (alpha[neighbour] >= 128) !== ink) continue;
            visited[neighbour] = 1;
            queue[length++] = neighbour;
          }
        }
      }
      if (ink) smallestInk = Math.min(smallestInk, length);
      else if (!touchesEdge) smallestHole = Math.min(smallestHole, length);
    }

    const clearedRegions = [[324, 692, 344, 735], [728, 0, 736, 9], [1197, 795, 1200, 800]];
    const residualInk = clearedRegions.map(([left, top, right, bottom]) => {
      let count = 0;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) count += Number(alpha[y * width + x] >= 128);
      }
      return count;
    });

    const surveyAlpha = await decode(survey, 1600, 800);
    const histogram = new Uint32Array(256);
    for (const value of surveyAlpha) histogram[value]++;
    const nonTransparent = surveyAlpha.length - histogram[0];
    const maxMidAlpha = Math.max(...histogram.slice(40, 216));
    const edgeColumns = [0, 1599].map(x => {
      const column = Array.from({ length: 800 }, (_, y) => surveyAlpha[y * 1600 + x]);
      return { ink: column.filter(value => value === 255).length,
        empty: column.filter(value => value === 0).length };
    });
    return { smallestInk, smallestHole, residualInk, nonTransparent, maxMidAlpha, edgeColumns };
  }, {
    contour: readFileSync(asset('plate-contours.webp')).toString('base64'),
    survey: readFileSync(asset('art-survey-plate.webp')).toString('base64'),
  });
  console.log('Plates', plates);
  assert(plates.smallestInk >= 30 && Number.isFinite(plates.smallestInk));
  assert(plates.smallestHole >= 100 && Number.isFinite(plates.smallestHole));
  assert.deepEqual(plates.residualInk, [0, 0, 0]);
  assert(plates.maxMidAlpha / plates.nonTransparent <= .02);
  assert(plates.edgeColumns.every(column => column.ink === 800) ||
    plates.edgeColumns.every(column => column.empty === 800));

  const palettes = [
    { ink: '#1a2834', paper: '#f3f0e7' },
    { ink: '#efebe0', paper: '#0e151b' },
  ];
  const emblemCases = [20, 24].flatMap(size => palettes.map(palette => ({ size, ...palette })));
  for (const { size, ink, paper } of emblemCases) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>body{margin:0;color:${ink};background:${paper}}svg{display:block;width:${size}px;height:${size}px}</style>${emblem}`);
    const full = (await page.screenshot()).toString('base64');
    await page.addStyleTag({ content: 'svg g { visibility: hidden; }' });
    const triangle = (await page.screenshot()).toString('base64');
    const measured = await page.evaluate(async ({ full, triangle, size, ink, paper }) => {
      async function coverage(png: string) {
        const image = new Image();
        image.src = 'data:image/png;base64,' + png;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(image, 0, 0);
        const red = (hex: string) => parseInt(hex.slice(1, 3), 16);
        const background = red(paper);
        const { data } = ctx.getImageData(0, 0, size, size);
        return Array.from({ length: size * size }, (_, i) => (data[4*i] - background) / (red(ink) - background));
      }
      const actual = await coverage(full);
      const solo = await coverage(triangle);
      const core = new Set(solo.flatMap((alpha, i) => alpha >= .35 ? [i] : []));
      if (!core.size) throw new Error('Triangle has no pixels above the coverage threshold');
      const neighbours = (i: number) => {
        const x = i % size;
        const y = Math.floor(i / size);
        const result = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if ((dx || dy) && x + dx >= 0 && x + dx < size && y + dy >= 0 && y + dy < size) {
              result.push(i + dx + dy * size);
            }
          }
        }
        return result;
      };
      const connected = new Set<number>();
      const stack = [core.values().next().value!];
      while (stack.length) {
        const i = stack.pop()!;
        if (connected.has(i) || !(actual[i] >= .35)) continue;
        connected.add(i);
        stack.push(...neighbours(i));
      }
      const ring = [...connected].flatMap(neighbours).filter(i => !connected.has(i));
      const rows = Array<number>(size).fill(0);
      for (const i of connected) rows[Math.floor(i / size)]++;
      return {
        rowWidths: rows.filter(Boolean),
        core: core.size,
        connected: connected.size,
        sameComponent: [...core].every(i => connected.has(i)),
        ringMax: Math.max(...ring.map(i => actual[i])),
      };
    }, { full, triangle, size, ink, paper });
    console.log('Emblem', size, paper, measured);
    const { connected, core, rowWidths, ringMax, sameComponent } = measured;
    assert(sameComponent && core === connected && connected >= 5);
    assert(rowWidths.length >= 3 && rowWidths.at(-1)! > rowWidths[0]);
    assert(ringMax <= .2);
  }
} finally {
  await browser.close();
}

for (const [script, name] of [
  ['contours.ts', 'plate-contours.webp'],
  ['survey-plate.ts', 'art-survey-plate.webp'],
]) {
  const output = asset(name);
  assert(statSync(output).size <= 150_000);
  const before = readFileSync(output);
  execFileSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], { stdio: 'inherit' });
  assert(readFileSync(output).equals(before), `${name} did not reproduce byte for byte`);
}
