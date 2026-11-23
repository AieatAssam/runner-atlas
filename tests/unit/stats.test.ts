import { describe, expect, it } from 'vitest';
import {
  acfAt,
  benjaminiHochberg,
  bootstrapCI,
  mannWhitney,
  medianPolish,
  median,
  quantile,
  spearman,
  theilSen,
} from '../../aggregator/src/stats.ts';
import { uniformStream } from '../../aggregator/src/prng.ts';

describe('quantiles (type 7)', () => {
  it('interpolates linearly between order statistics', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 12);
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 12);
    expect(quantile([1, 2, 3, 4], 0.75)).toBeCloseTo(3.25, 12);
    expect(median([9, 1, 5])).toBe(5);
  });
});

describe('Mann-Whitney U', () => {
  it('matches the hand-computed reference for separated samples', () => {
    // U1 = 0, mean 4.5, sd sqrt(9 * 7 / 12); z = -1.96396; two-sided p = 0.04953.
    const r = mannWhitney([1, 2, 3], [4, 5, 6]);
    expect(r).not.toBeNull();
    expect(r!.u1).toBe(0);
    expect(r!.z).toBeCloseTo(-1.964, 3);
    expect(r!.p).toBeCloseTo(0.0495, 3);
  });

  it('returns null for an empty sample', () => {
    expect(mannWhitney([], [1, 2])).toBeNull();
  });
});

describe('Benjamini-Hochberg', () => {
  it('adjusts p-values with the step-up monotone minimum', () => {
    const adj = benjaminiHochberg([0.01, 0.04, 0.03, 0.005]);
    expect(adj[0]).toBeCloseTo(0.02, 12);
    expect(adj[1]).toBeCloseTo(0.04, 12);
    expect(adj[2]).toBeCloseTo(0.04, 12);
    expect(adj[3]).toBeCloseTo(0.02, 12);
  });
});

describe('rank and linear statistics', () => {
  it('Spearman is 1 for any strictly monotone relation', () => {
    expect(spearman([1, 2, 3, 4], [1, 4, 9, 16])).toBeCloseTo(1, 12);
    expect(spearman([1, 2, 3, 4], [16, 9, 4, 1])).toBeCloseTo(-1, 12);
  });

  it('Theil-Sen recovers an exact line', () => {
    expect(theilSen([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(2, 12);
  });

  it('acfAt is 1 at lag 0 for a constant-free series', () => {
    const series = [1, 3, 2, 5, 4, 6, 8, 7, 9, 12];
    expect(acfAt(series, 0)).toBeCloseTo(1, 12);
  });
});

describe('bootstrap determinism', () => {
  const units = Array.from({ length: 60 }, (_, i) => (i * 37) % 53);

  it('same key gives the same interval', () => {
    const a = bootstrapCI(units, 'unit-test', median, 200);
    const b = bootstrapCI(units, 'unit-test', median, 200);
    expect(a).toEqual(b);
  });

  it('different keys give different resamples', () => {
    const a = bootstrapCI(units, 'key-a', median, 200);
    const b = bootstrapCI(units, 'key-b', median, 200);
    expect(a).not.toEqual(b);
  });

  it('uniform streams are reproducible from the key alone', () => {
    const f = uniformStream('stream-check');
    const g = uniformStream('stream-check');
    const xs = Array.from({ length: 5 }, () => f());
    expect(xs).toEqual(Array.from({ length: 5 }, () => g()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe('hand-checked references', () => {
  it('Mann-Whitney with a tie group of three', () => {
    // Ranks 1, 3, 3 | 3, 5, 6: U1 = 7 - 6 = 1; var = 9/12 * (7 - 24/30) = 4.65; z = -3.5 / sqrt(4.65) = -1.62308.
    const r = mannWhitney([1, 2, 2], [2, 3, 4])!;
    expect(r.u1).toBe(1);
    expect(r.z).toBeCloseTo(-1.62308, 4);
    expect(r.p).toBeCloseTo(0.10457, 4);
  });

  it('Mann-Whitney keeps p above zero for strong separations and is p = 1 when every value ties', () => {
    const a = Array.from({ length: 200 }, (_, i) => i);
    const b = Array.from({ length: 200 }, (_, i) => 1000 + i);
    const r = mannWhitney(a, b)!;
    expect(Math.abs(r.z)).toBeGreaterThan(17);
    expect(r.p).toBeGreaterThan(0);
    expect(r.p).toBeLessThan(1e-60);
    expect(mannWhitney([5, 5, 5], [5, 5])).toEqual({ u1: 3, z: 0, p: 1 });
  });

  it('median polish recovers centred effects of an additive table, gaps included', () => {
    const a = [0, 10, 20];
    const b = [1, 2, 4, 8];
    const t: (number | null)[][] = a.map((ar) => b.map((bc) => ar + bc));
    let fx = medianPolish(t);
    expect(fx.rowEff).toEqual([-10, 0, 10]);
    expect(fx.colEff).toEqual([-2.75, -1.75, 0.25, 4.25]);
    t[1][2] = null;
    fx = medianPolish(t);
    expect(fx.rowEff.map((v) => v! + 0)).toEqual([-10, 0, 10]);
    expect(fx.colEff).toEqual([-2.75, -1.75, 0.25, 4.25]);
    expect(medianPolish([])).toEqual({ rowEff: [], colEff: [] });
    expect(medianPolish([[null, null]])).toEqual({ rowEff: [null], colEff: [null, null] });
  });

  it('Theil-Sen, ACF and bootstrap return null rather than NaN on degenerate input', () => {
    expect(theilSen([], [])).toBeNull();
    expect(theilSen([1], [5])).toBeNull();
    expect(theilSen([2, 2, 2], [1, 5, 9])).toBeNull();
    expect(theilSen([0, 1, 2, 3], [7, 7, 7, 7])).toBe(0);
    expect(acfAt([], 1)).toBeNull();
    expect(acfAt([4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4], 1)).toBeNull();
    expect(acfAt([1, null, 3, null, 5], 1)).toBeNull();
    expect(bootstrapCI([], 'k', () => 1)).toBeNull();
    expect(bootstrapCI([3], 'k', (r) => median(r))).toEqual([3, 3]);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
  });
});
