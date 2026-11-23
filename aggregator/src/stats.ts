// Statistics for SPEC 4. Every function is pure and deterministic. Null inputs are the caller's job to filter.
import { uniformStream } from './prng.ts';

export function sortAsc(xs: number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

// Type 7 (linear interpolation) on an already sorted array.
export function quantileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) throw new Error('quantile of empty array');
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function quantile(xs: number[], p: number): number {
  return quantileSorted(sortAsc(xs), p);
}

export function median(xs: number[]): number {
  return quantile(xs, 0.5);
}

export function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

// Sample standard deviation (n - 1); 0 when n < 2.
export function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

// Median absolute deviation scaled by 1.4826 (consistent with sd under normality).
export function mad(xs: number[]): number {
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

// Average ranks (ties share the mean rank), 1-based.
export function ranks(xs: number[]): number[] {
  const order = xs.map((v, i) => i).sort((a, b) => xs[a] - xs[b] || a - b);
  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && xs[order[j + 1]] === xs[order[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k]] = avg;
    i = j + 1;
  }
  return out;
}

export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length < 3) return null;
  return pearson(ranks(xs), ranks(ys));
}

// OLS slope and intercept of y on x.
export function olsFit(xs: number[], ys: number[]): { slope: number; intercept: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

// Standard normal CDF (Hart 1968, as in W. West 2005). Double precision.
export function normCdf(x: number): number {
  const xabs = Math.abs(x);
  let c: number;
  if (xabs > 37) {
    c = 0;
  } else {
    const e = Math.exp((-xabs * xabs) / 2);
    if (xabs < 7.07106781186547) {
      let b = 3.52624965998911e-2 * xabs + 0.700383064443688;
      b = b * xabs + 6.37396220353165;
      b = b * xabs + 33.912866078383;
      b = b * xabs + 112.079291497871;
      b = b * xabs + 221.213596169931;
      b = b * xabs + 220.206867912376;
      c = (e * b);
      let d = 8.83883476483184e-2 * xabs + 1.75566716318264;
      d = d * xabs + 16.064177579207;
      d = d * xabs + 86.7807322029461;
      d = d * xabs + 296.564248779674;
      d = d * xabs + 637.333633378831;
      d = d * xabs + 793.826512519948;
      d = d * xabs + 440.413735824752;
      c = c / d;
    } else {
      let b = xabs + 0.65;
      b = xabs + 4 / b;
      b = xabs + 3 / b;
      b = xabs + 2 / b;
      b = xabs + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

export interface MannWhitney {
  u1: number; // U statistic for the first sample
  z: number;  // normal approximation with tie correction (no continuity correction)
  p: number;  // two-sided
}

// Two-sided Mann-Whitney U, normal approximation with tie correction. null when a sample is empty.
export function mannWhitney(a: number[], b: number[]): MannWhitney | null {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) return null;
  const all = [...a, ...b];
  const r = ranks(all);
  let r1 = 0;
  for (let i = 0; i < n1; i++) r1 += r[i];
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const n = n1 + n2;
  // Tie groups.
  const sorted = sortAsc(all);
  let tieSum = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && sorted[j + 1] === sorted[i]) j++;
    const t = j - i + 1;
    tieSum += t * t * t - t;
    i = j + 1;
  }
  const variance = ((n1 * n2) / 12) * (n + 1 - tieSum / (n * (n - 1)));
  if (!(variance > 0)) return { u1, z: 0, p: 1 };
  const mu = (n1 * n2) / 2;
  const z = (u1 - mu) / Math.sqrt(variance);
  // Lower tail directly: 1 - cdf(|z|) cancels to 0 for |z| > ~8.3, which made distinct splits tie at p = 0.
  const p = Math.min(1, 2 * normCdf(-Math.abs(z)));
  return { u1, z, p };
}

// Benjamini-Hochberg adjusted p-values, same order as input.
export function benjaminiHochberg(ps: number[]): number[] {
  const m = ps.length;
  const order = ps.map((_, i) => i).sort((a, b) => ps[a] - ps[b] || a - b);
  const adj = new Array<number>(m);
  let running = 1;
  for (let k = m - 1; k >= 0; k--) {
    const idx = order[k];
    running = Math.min(running, (ps[idx] * m) / (k + 1));
    adj[idx] = running;
  }
  return adj;
}

// Theil-Sen estimator: median of pairwise slopes.
export function theilSen(xs: number[], ys: number[]): number | null {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      if (xs[j] !== xs[i]) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
    }
  }
  return slopes.length === 0 ? null : median(slopes);
}

// Silverman bandwidth with the SPEC 4.4 fallbacks.
export function silvermanBandwidth(xs: number[], domain: [number, number]): number {
  const n = xs.length;
  const sorted = sortAsc(xs);
  const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25);
  const s = sd(xs);
  let spread = Math.min(s, iqr / 1.34);
  if (spread === 0) spread = s;
  let h = 0.9 * spread * n ** -0.2;
  if (h === 0) h = (domain[1] - domain[0]) / 64;
  return h;
}

// Gaussian KDE on a grid, scaled to peak 1.
export function gaussianKdeScaled(xs: number[], grid: number[], h: number): number[] {
  const norm = 1 / (xs.length * h * Math.sqrt(2 * Math.PI));
  const dens = grid.map((g) => {
    let s = 0;
    for (const x of xs) {
      const z = (g - x) / h;
      s += Math.exp((-0.5 * z * z));
    }
    return s * norm;
  });
  const peak = Math.max(...dens);
  return peak > 0 ? dens.map((d) => d / peak) : dens;
}

// Histogram with end-bin clamping (SPEC 4.4).
export function histogram(xs: number[], domain: [number, number], bins = 32): number[] {
  const out = new Array<number>(bins).fill(0);
  const [lo, hi] = domain;
  const width = (hi - lo) / bins;
  for (const x of xs) {
    let idx = Math.floor((x - lo) / width);
    if (idx < 0) idx = 0;
    if (idx >= bins) idx = bins - 1;
    out[idx]++;
  }
  return out;
}

// Percentile bootstrap over resampling units (e.g. runs). B = 1000 by default.
// Stream key names the statistic (SPEC 4.1). Returns null when no replicate yields a value.
export function bootstrapCI<T>(
  units: T[],
  key: string,
  stat: (resample: T[]) => number | null,
  B = 1000,
): [number, number] | null {
  const n = units.length;
  if (n === 0) return null;
  const rng = uniformStream(`bootstrap:${key}`);
  const values: number[] = [];
  for (let b = 0; b < B; b++) {
    const sample = new Array<T>(n);
    for (let i = 0; i < n; i++) sample[i] = units[Math.floor(rng() * n)];
    const v = stat(sample);
    if (v !== null && Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) return null;
  const sorted = sortAsc(values);
  return [quantileSorted(sorted, 0.025), quantileSorted(sorted, 0.975)];
}

// Two-way median polish (SPEC 4.7). table[row][col], null cells skipped. Returns centred row and column effects.
export function medianPolish(
  table: (number | null)[][],
  iterations = 2,
): { rowEff: (number | null)[]; colEff: (number | null)[] } {
  const rows = table.length;
  const cols = rows > 0 ? table[0].length : 0;
  const resid = table.map((r) => r.map((v) => v));
  const rowEff = new Array<number>(rows).fill(0);
  const colEff = new Array<number>(cols).fill(0);
  const rowHas = new Array<boolean>(rows).fill(false);
  const colHas = new Array<boolean>(cols).fill(false);
  for (let it = 0; it < iterations; it++) {
    for (let r = 0; r < rows; r++) {
      const vals = resid[r].filter((v): v is number => v !== null);
      if (vals.length === 0) continue;
      const m = median(vals);
      rowHas[r] = true;
      rowEff[r] += m;
      resid[r] = resid[r].map((v) => (v === null ? null : v - m));
    }
    for (let c = 0; c < cols; c++) {
      const vals: number[] = [];
      for (let r = 0; r < rows; r++) if (resid[r][c] !== null) vals.push(resid[r][c] as number);
      if (vals.length === 0) continue;
      const m = median(vals);
      colHas[c] = true;
      colEff[c] += m;
      for (let r = 0; r < rows; r++) if (resid[r][c] !== null) resid[r][c] = (resid[r][c] as number) - m;
    }
  }
  const rowVals = rowEff.filter((_, i) => rowHas[i]);
  const colVals = colEff.filter((_, i) => colHas[i]);
  const rowMean = rowVals.length ? mean(rowVals) : 0;
  const colMean = colVals.length ? mean(colVals) : 0;
  return {
    rowEff: rowEff.map((v, i) => (rowHas[i] ? v - rowMean : null)),
    colEff: colEff.map((v, i) => (colHas[i] ? v - colMean : null)),
  };
}

// Autocorrelation at one lag over a series with gaps (SPEC 4.7): pairs where both values exist, at least 10 pairs.
export function acfAt(series: (number | null)[], lag: number): number | null {
  const vals = series.filter((v): v is number => v !== null);
  if (vals.length < 2) return null;
  const m = mean(vals);
  let denom = 0;
  for (const v of vals) denom += (v - m) ** 2;
  if (denom === 0) return null;
  let num = 0;
  let pairs = 0;
  for (let t = 0; t + lag < series.length; t++) {
    const a = series[t];
    const b = series[t + lag];
    if (a === null || b === null) continue;
    num += (a - m) * (b - m);
    pairs++;
  }
  return pairs < 10 ? null : num / denom;
}
