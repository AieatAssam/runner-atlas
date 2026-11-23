// Image rollouts and change points (SPEC 4.6).
import type { RawSample, RunnerLabel } from '../../shared/types/sample.ts';
import type { MetricId, RolloutsRollup } from '../../shared/types/rollups.ts';
import { DECIMALS, LABELS, cmp, metricValue, round, utcDate } from './common.ts';
import { cpuFamily } from './hardware.ts';
import { benjaminiHochberg, mannWhitney, median } from './stats.ts';
import { headOf, type Ctx } from './summary.ts';

type Series = MetricId | 'totalDelaySec';
const SERIES: Series[] = ['singleCoreScore', 'multiCoreScore', 'seqWriteMBs', 'memBandwidthGBs', 'totalDelaySec'];
const TOP = 7;
const EVENT_SHARE = 0.2; // fraction of the day's samples
const MAX_PER_SERIES = 3;
const MIN_SEGMENT_DAYS = 3;
const MIN_SEGMENT_SAMPLES = 30;
const MIN_SHIFT_PCT = 3;
const ALPHA = 0.05;

const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function tally(
  ls: RawSample[],
  keyOf: (s: RawSample) => string,
  dayIdx: Map<string, number>,
  D: number,
): { totals: number[]; counts: Map<string, number[]> } {
  const totals = new Array<number>(D).fill(0);
  const counts = new Map<string, number[]>();
  for (const s of ls) {
    const i = dayIdx.get(utcDate(s.collectedAtIso));
    if (i === undefined) throw new Error(`sample outside survey range: ${s.id}`);
    totals[i]++;
    const k = keyOf(s);
    let arr = counts.get(k);
    if (!arr) {
      arr = new Array<number>(D).fill(0);
      counts.set(k, arr);
    }
    arr[i]++;
  }
  return { totals, counts };
}

// Top keys by samples, the rest pooled as "other".
function pooled(counts: Map<string, number[]>, D: number): Array<{ key: string; counts: number[] }> {
  const keys = [...counts.keys()].sort((a, b) => sumOf(counts.get(b)!) - sumOf(counts.get(a)!) || cmp(a, b));
  const out = keys.slice(0, TOP).map((key) => ({ key, counts: counts.get(key)! }));
  if (keys.length > TOP) {
    const other = new Array<number>(D).fill(0);
    for (const k of keys.slice(TOP)) counts.get(k)!.forEach((c, i) => (other[i] += c));
    out.push({ key: 'other', counts: other });
  }
  return out;
}

const shareOf = (counts: number[], totals: number[]) =>
  counts.map((c, i) => (totals[i] > 0 ? round(c / totals[i], 4) : null));

const firstIdx = (arr: number[]) => arr.findIndex((c) => c > 0);
const lastIdx = (arr: number[]) => {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] > 0) return i;
  return -1;
};

interface Split {
  seg: number;
  k: number;
  p: number;
  absZ: number; // ranks splits; p underflows to 0 for strong shifts, |z| does not
  evaluated: number; // candidates tested in this split's segment (Bonferroni factor)
  before: number[];
  after: number[];
  u: number;
}

// Best split of days [a, b) by two-sided MWU (largest |z|, earliest on ties), counting every valid candidate evaluated.
function bestSplit(days: number[][], a: number, b: number): { best: Split | null; evaluated: number } {
  let best: Split | null = null;
  let evaluated = 0;
  for (let k = a + MIN_SEGMENT_DAYS; k <= b - MIN_SEGMENT_DAYS; k++) {
    const before = days.slice(a, k).flat();
    const after = days.slice(k, b).flat();
    if (before.length < MIN_SEGMENT_SAMPLES || after.length < MIN_SEGMENT_SAMPLES) continue;
    evaluated++;
    const mw = mannWhitney(before, after);
    if (!mw) continue;
    const absZ = Math.abs(mw.z);
    if (best === null || absZ > best.absZ) best = { seg: -1, k, p: mw.p, absZ, evaluated: 0, before, after, u: mw.u1 };
  }
  if (best) best.evaluated = evaluated;
  return { best, evaluated };
}

interface Raw {
  label: RunnerLabel;
  series: Series;
  date: string;
  dayIndex: number;
  before: { median: number; n: number };
  after: { median: number; n: number };
  shiftPct: number;
  u: number;
  pRaw: number;
  pBonf: number;
}

export function buildRollouts(ctx: Ctx): RolloutsRollup {
  const D = ctx.days.length;
  const dayIdx = new Map(ctx.days.map((d, i) => [d, i]));
  const raws: Raw[] = [];
  const byLabel: RolloutsRollup['byLabel'] = [];
  const eventsByLabel = new Map<RunnerLabel, Array<{ date: string; from: string; to: string }>>();

  for (const label of LABELS) {
    const ls = ctx.samples.filter((s) => s.label === label);
    const img = tally(ls, (s) => s.env.imageVersion ?? 'unknown', dayIdx, D);
    const fam = tally(ls, (s) => cpuFamily(s.cpu.model), dayIdx, D);

    // Image events: each version new after the baseline day emits one event at its first day with share >= 20%.
    const events: Array<{ date: string; from: string; to: string }> = [];
    const i0 = img.totals.findIndex((t) => t > 0);
    if (i0 >= 0) {
      const dominantAt = (i: number): string => {
        let best = '';
        let bestN = -1;
        for (const [k, arr] of img.counts) {
          if (arr[i] > bestN || (arr[i] === bestN && k < best)) {
            best = k;
            bestN = arr[i];
          }
        }
        return best;
      };
      const baseline = new Set([...img.counts.keys()].filter((k) => img.counts.get(k)![i0] > 0));
      const keys = [...img.counts.keys()].filter((k) => !baseline.has(k));
      keys.sort((a, b) => firstIdx(img.counts.get(a)!) - firstIdx(img.counts.get(b)!) || cmp(a, b));
      for (const k of keys) {
        const arr = img.counts.get(k)!;
        for (let i = i0 + 1; i < D; i++) {
          if (img.totals[i] > 0 && arr[i] / img.totals[i] >= EVENT_SHARE) {
            let j = i - 1;
            while (img.totals[j] === 0) j--;
            events.push({ date: ctx.days[i], from: dominantAt(j), to: k });
            break;
          }
        }
      }
    }
    events.sort((a, b) => cmp(a.date, b.date) || cmp(a.to, b.to));
    eventsByLabel.set(label, events);

    const imgs = pooled(img.counts, D);
    const fams = pooled(fam.counts, D);
    byLabel.push({
      label,
      images: imgs.map(({ key, counts }) => ({
        version: key,
        firstSeen: ctx.days[firstIdx(counts)] ?? '',
        lastSeen: ctx.days[lastIdx(counts)] ?? '',
        share: shareOf(counts, img.totals),
      })),
      families: fams.map(({ key, counts }) => ({ family: key, share: shareOf(counts, fam.totals) })),
      events,
    });
  }

  // Change points per label x series (SPEC 4.6).
  for (const label of LABELS) {
    const ls = ctx.samples.filter((s) => s.label === label);
    const events = eventsByLabel.get(label) ?? [];
    for (const metric of SERIES) {
      const days: number[][] = Array.from({ length: D }, () => []);
      for (const s of ls) {
        const v = seriesValue(s, metric);
        if (v === null) continue;
        days[dayIdx.get(utcDate(s.collectedAtIso))!].push(v);
      }
      let segs: Array<[number, number]> = [[0, D]];
      const found: Array<Split & { a: number; b: number }> = [];
      for (let step = 0; step < MAX_PER_SERIES; step++) {
        let best: (Split & { a: number; b: number }) | null = null;
        let bestSeg = -1;
        segs.forEach(([a, b], si) => {
          const r = bestSplit(days, a, b);
          if (r.best && (best === null || r.best.absZ > best.absZ)) {
            best = { ...r.best, seg: si, a, b };
            bestSeg = si;
          }
        });
        if (best === null) break;
        const bb: Split & { a: number; b: number } = best;
        found.push(bb);
        const [a, b] = segs[bestSeg];
        segs = [...segs.slice(0, bestSeg), [a, bb.k], [bb.k, b], ...segs.slice(bestSeg + 1)];
      }
      const d = DECIMALS[metric];
      for (const f of found) {
        const mb = median(f.before);
        const ma = median(f.after);
        raws.push({
          label,
          series: metric,
          date: ctx.days[f.k],
          dayIndex: f.k,
          before: { median: round(mb, d), n: f.before.length },
          after: { median: round(ma, d), n: f.after.length },
          shiftPct: round(mb !== 0 ? ((ma - mb) / mb) * 100 : 0, 2),
          u: round(f.u, 1),
          pRaw: f.p,
          // Bonferroni within the series: the split's p times the candidates tested for it (SPEC 4.6).
          pBonf: Math.min(1, f.p * f.evaluated),
        });
      }
    }
  }

  const pAdj = benjaminiHochberg(raws.map((r) => r.pBonf));
  const changePoints = raws
    .map((r, i) => {
      const nearImageEvent = (eventsByLabel.get(r.label) ?? []).some(
        (e) => Math.abs((dayIdx.get(e.date) ?? -99) - r.dayIndex) <= 1,
      );
      return {
        label: r.label,
        metric: r.series,
        date: r.date,
        before: r.before,
        after: r.after,
        shiftPct: r.shiftPct,
        u: r.u,
        pRaw: round(r.pRaw, 6),
        pAdj: round(pAdj[i], 6),
        nearImageEvent,
        keep: pAdj[i] < ALPHA && Math.abs(r.shiftPct) >= MIN_SHIFT_PCT,
      };
    })
    .filter((c) => c.keep)
    .map(({ keep: _keep, ...rest }) => rest)
    .sort((a, b) => LABELS.indexOf(a.label) - LABELS.indexOf(b.label) || SERIES.indexOf(a.metric) - SERIES.indexOf(b.metric) || cmp(a.date, b.date));

  return {
    ...headOf('rollouts', ctx),
    days: ctx.days,
    byLabel,
    changePoints,
    method: {
      test: 'mann-whitney-u',
      alpha: 0.05,
      minSegmentDays: 3,
      minSegmentSamples: 30,
      minShiftPct: 3,
      maxPerSeries: 3,
    },
  };
}

function seriesValue(s: RawSample, metric: Series): number | null {
  if (metric === 'totalDelaySec') return s.event === 'schedule' ? s.timing.totalDelaySec : null;
  return metricValue(s, metric);
}
