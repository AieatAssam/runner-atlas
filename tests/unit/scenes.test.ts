import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  declutter, fitScale, gridStep, keyAction, rampIndex, sceneHeight, stepIndex, zoomFactor,
} from '../../site/src/scenes/_common.ts';
import {
  COLS, ROWS, beacons, cellCentre, cellSentence, extent, heightOf, isolineSegments, quadPositions, surfaceValues,
} from '../../site/src/scenes/terrain.ts';
import { buildModel, normalise, targetSentence, targetsOf } from '../../site/src/scenes/pointcloud.ts';
import {
  graticule, latLonToVector, pylonHeight, regionOrder, regionSentence, ringRadius, yawToFace,
} from '../../site/src/scenes/globe.ts';
import type { DriftCell, SlotScore, BenchmarksRollup, RegionsRollup } from '../../shared/types/rollups.ts';

const SCENES = ['_common', 'terrain', 'pointcloud', 'globe'] as const;

describe('shared scene helpers', () => {
  it('declutters overlapping labels upward and keeps them on the stage', () => {
    const a = { x: 100, y: 100, width: 80, height: 20 };
    const [first, second, third] = declutter([a, { ...a, x: 110 }, { x: 400, y: 100, width: 80, height: 20 }], 420, 300);
    expect(first).toEqual({ left: 60, top: 78, width: 80, height: 20 });
    expect(second!.top + second!.height).toBeLessThanOrEqual(first!.top);
    expect(third!.top).toBe(78);
    expect(third!.left + third!.width).toBeLessThanOrEqual(420);
  });

  it('stacks labels below the anchor when there is no room above, and never leaves the stage', () => {
    const a = { x: 100, y: 30, width: 80, height: 20 };
    const boxes = declutter([a, a, a, a], 200, 120);
    for (const b of boxes) {
      expect(b.top).toBeGreaterThanOrEqual(0);
      expect(b.top + b.height).toBeLessThanOrEqual(120);
    }
    const tops = boxes.map((b) => b.top).sort((x, y) => x - y);
    for (let i = 1; i < tops.length; i++) expect(tops[i]! - tops[i - 1]!).toBeGreaterThanOrEqual(20);
    expect(fitScale(1.6)).toBe(1);
    expect(fitScale(0.8)).toBe(2);
  });

  it('maps keys to actions and ignores the rest', () => {
    expect(keyAction('ArrowLeft')).toBe('left');
    expect(keyAction('+')).toBe('zoomIn');
    expect(keyAction('-')).toBe('zoomOut');
    expect(keyAction('0')).toBe('reset');
    expect(keyAction(' ')).toBe('pause');
    expect(keyAction('Escape')).toBe('escape');
    expect(keyAction('a')).toBeNull();
  });

  it('steps a cursor with wrap and without', () => {
    expect(stepIndex(-1, 1, 4)).toBe(0);
    expect(stepIndex(-1, -1, 4)).toBe(3);
    expect(stepIndex(3, 1, 4)).toBe(0);
    expect(stepIndex(3, 1, 4, false)).toBe(3);
    expect(stepIndex(0, -1, 4, false)).toBe(0);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });

  it('clamps grid steps at the edges', () => {
    expect(gridStep(0, 0, 'left', 24, 7)).toEqual([0, 0]);
    expect(gridStep(23, 6, 'down', 24, 7)).toEqual([23, 6]);
    expect(gridStep(5, 2, 'right', 24, 7)).toEqual([6, 2]);
  });

  it('keeps zoom direction and scene height bounded', () => {
    expect(zoomFactor('zoomIn')).toBeLessThan(1);
    expect(zoomFactor('zoomOut')).toBeGreaterThan(1);
    expect(sceneHeight(100)).toBe(260);
    expect(sceneHeight(5000)).toBe(560);
  });

  it('bins ramp values and marks missing ones', () => {
    expect(rampIndex(0, 0, 10, 7)).toBe(0);
    expect(rampIndex(10, 0, 10, 7)).toBe(6);
    expect(rampIndex(null, 0, 10, 7)).toBe(-1);
    expect(rampIndex(5, 3, 3, 7)).toBe(0);
  });
});

function cell(weekday: number, hour: number, median: number | null): DriftCell {
  return {
    weekday, hourUtc: hour, runs: median === null ? 0 : 4, samples: median === null ? 0 : 8,
    drift: null, queue: null, total: median === null ? null : { median, p25: median, p75: median, p95: median },
    score: null, ci95: null,
  };
}

describe('terrain scene', () => {
  const cells: DriftCell[] = [];
  for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) cells.push(cell(w, h, w * 24 + h));

  it('lays out one value per slot and a height per value', () => {
    const values = surfaceValues(cells);
    expect(values).toHaveLength(COLS * ROWS);
    const { min, max } = extent(values);
    expect(min).toBe(0);
    expect(max).toBe(6 * 24 + 23);
    expect(heightOf(null, min, max)).toBe(0);
    expect(heightOf(max, min, max)).toBeGreaterThan(heightOf(min, min, max));
  });

  it('emits four corners per cell and keeps cell centres symmetric about the origin', () => {
    const values = surfaceValues(cells);
    expect(quadPositions(values, 0, 167).length).toBeGreaterThan(0);
    // Every triangle faces up (+y normal), or the surface is back-face culled and vanishes.
    const flat = quadPositions(Array(COLS * ROWS).fill(null), null, null);
    for (let t = 0; t < flat.length; t += 9) {
      const [ax, , az, bx, , bz, cx, , cz] = Array.from(flat.subarray(t, t + 9));
      expect((bz! - az!) * (cx! - ax!) - (bx! - ax!) * (cz! - az!)).toBeGreaterThan(0);
    }
    const left = cellCentre(0, 0)[0];
    const right = cellCentre(COLS - 1, 0)[0];
    expect(left).toBeCloseTo(-right);
  });

  it('finds isolines inside the grid for a threshold that splits it', () => {
    const values = Array.from({ length: COLS * ROWS }, (_, i) => (i % COLS < COLS / 2 ? 0 : 1));
    const segments = isolineSegments(values, 0.5);
    expect(segments.length).toBeGreaterThan(0);
    for (const [x0, y0, x1, y1] of segments) {
      for (const v of [x0, x1]) expect(v).toBeGreaterThanOrEqual(0);
      for (const v of [y0, y1]) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('picks the fastest and slowest slots as beacons', () => {
    const slot = (weekday: number, hourUtc: number, score: number): SlotScore => ({
      weekday, hourUtc, runs: 3, samples: 6, medianSec: score, p90Sec: score, score, ci95: [score, score],
    });
    const out = beacons([slot(1, 2, 5), slot(2, 3, 6)], [slot(3, 4, 90)], 3);
    expect(out.map((b) => b.kind)).toEqual(['best', 'best', 'worst']);
  });

  it('describes a cell with a sentence and a fallback for empty cells', () => {
    expect(cellSentence(undefined, 1, 9)).toMatch(/no runs/i);
    expect(cellSentence(cell(1, 9, 60), 1, 9)).toMatch(/9/);
  });
});

function benchmarks(): BenchmarksRollup {
  const families = ['Alpha', 'Beta'];
  const family = [0, 0, 0, 1, 1, 1, 1];
  const single = [100, 102, 98, 200, 201, 199, 900];   // 900 sits in Beta, whose mad is 0, so it is skipped
  const write = [500, 510, 490, 1000, 1005, 995, 1000];
  const mem = [40, 41, 39, 80, 81, 79, 80];
  return {
    metrics: [
      { id: 'singleCoreScore', domain: [0, 1000] },
      { id: 'seqWriteMBs', domain: [0, 2000] },
      { id: 'memBandwidthGBs', domain: [0, 200] },
    ],
    points: { labels: ['l'], families, family, label: family.map(() => 0), single, write, mem, multi: [], date: [] },
    byHardware: { singleCoreScore: [
      { key: 'l|Alpha', q: { p50: 100 }, mad: 2 },
      { key: 'l|Beta', q: { p50: 200 }, mad: 0 },
    ] },
  } as unknown as BenchmarksRollup;
}

describe('pointcloud scene', () => {
  it('normalises to 0..1 and sits at the middle for an empty domain', () => {
    expect(normalise([0, 500, 1000], [0, 1000])).toEqual([0, 0.5, 1]);
    expect(normalise([3], null)).toEqual([0.5]);
  });

  it('builds family centroids and flags robust-z outliers per hardware group', () => {
    const model = buildModel(benchmarks());
    expect(model.centroids).toHaveLength(2);
    expect(model.centroids[0]!.n).toBe(3);
    expect(model.outliers).toEqual([]);
    const withOutlier = buildModel({ ...benchmarks(), points: { ...benchmarks().points, single: [100, 102, 120, 200, 201, 199, 900] } });
    expect(withOutlier.outliers).toEqual([2]);          // (120 - 100) / 2 = 10 > 3; Beta skipped (mad 0)
    expect(withOutlier.outlierZ[0]).toBeCloseTo(10);
    const targets = targetsOf(model);
    expect(targets.length).toBe(model.centroids.length + model.outliers.length);
    expect(targetSentence(model, targets[0]!)).toMatch(/centroid/);
  });
});

describe('globe scene', () => {
  it('places points on the sphere and puts the poles on the y axis', () => {
    for (const [lat, lon] of [[0, 0], [45, 120], [-30, -75]] as const) {
      const [x, y, z] = latLonToVector(lat, lon);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1);
    }
    expect(latLonToVector(90, 0)[1]).toBeCloseTo(1);
    expect(latLonToVector(-90, 0)[1]).toBeCloseTo(-1);
  });

  it('turns a longitude to face the camera', () => {
    for (const lon of [-150, -40, 0, 75]) {
      const [x, , z] = latLonToVector(0, lon);
      const a = yawToFace(lon);
      const rx = x * Math.cos(a) + z * Math.sin(a);
      const rz = -x * Math.sin(a) + z * Math.cos(a);
      expect(rx).toBeCloseTo(0);
      expect(rz).toBeCloseTo(1);
    }
  });

  it('scales pylons and rings monotonically and clamps them', () => {
    expect(pylonHeight(0, 100)).toBe(0);
    expect(pylonHeight(100, 100)).toBeGreaterThan(pylonHeight(25, 100));
    expect(ringRadius(1)).toBeGreaterThan(ringRadius(0));
    expect(ringRadius(2)).toBeCloseTo(ringRadius(1));
  });

  it('orders regions busiest first and writes a sentence for each', () => {
    const regions = [
      { region: 'b', lat: 0, lon: 0, samples: 5, ttfbMedianMs: null, totalDelayMedianSec: null },
      { region: 'a', lat: 0, lon: 0, samples: 9, ttfbMedianMs: 120, totalDelayMedianSec: 41 },
    ] as unknown as RegionsRollup['regions'];
    expect(regionOrder(regions)).toEqual([1, 0]);
    expect(regionSentence(regions[1]!, 14)).toMatch(/^a: /);
  });

  it('draws the full graticule at the requested spacing', () => {
    const g = graticule(30);
    expect(g.meridians).toHaveLength(12);
    expect(g.parallels).toHaveLength(5);
  });
});

describe('scene modules keep three out of the entry chunk', () => {
  for (const name of SCENES) {
    it(`${name}.ts imports three only as a type`, () => {
      const source = readFileSync(new URL(`../../site/src/scenes/${name}.ts`, import.meta.url), 'utf8');
      const runtimeImports = source.split('\n').filter((line) => /from ['"]three['"]/.test(line) && !/^import type /.test(line));
      expect(runtimeImports).toEqual([]);
    });
  }
});
