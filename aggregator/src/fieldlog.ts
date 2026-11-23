// Field log: deterministic sentences per UTC date (SPEC 4.8). Newest first. No LLM.
import type { RawSample } from '../../shared/types/sample.ts';
import type { Manifest, RolloutsRollup } from '../../shared/types/rollups.ts';
import { LINUX_LABELS, addDays, regionKey, round, utcDate } from './common.ts';
import { quantileSorted, sortAsc } from './stats.ts';
import type { Coverage, RunRec } from './drift.ts';
import type { Ctx } from './summary.ts';

export function formatDuration(sec: number): string {
  const total = Math.round(sec);
  if (total < 60) return `${total} s`;
  const m = Math.floor(total / 60);
  return `${m} min ${total - m * 60} s`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

// Reader-facing names for the change-point series; the site's chart labels use the same words.
const SERIES_NAMES: Record<string, string> = {
  singleCoreScore: 'Single core score',
  multiCoreScore: 'Multi core score',
  seqWriteMBs: 'Sequential write',
  memBandwidthGBs: 'Memory bandwidth',
  totalDelaySec: 'Total start delay',
};

export function buildFieldLog(
  ctx: Ctx,
  coverage: Coverage,
  runs: RunRec[],
  rollouts: RolloutsRollup,
): Manifest['fieldLog'] {
  if (ctx.range === null) return [];
  const last = ctx.range.to;
  const byDate = new Map<string, RawSample[]>();
  for (const s of ctx.samples) {
    const d = utcDate(s.collectedAtIso);
    const g = byDate.get(d);
    if (g) g.push(s);
    else byDate.set(d, [s]);
  }

  const entries: Manifest['fieldLog'] = [];
  for (const date of [...byDate.keys()].sort()) {
    const ls = byDate.get(date)!;
    const sentences: string[] = [];

    // 1. Always.
    const labelsSet = new Set(ls.map((s) => s.label));
    const regionsSet = new Set(ls.map(regionKey));
    sentences.push(`${ls.length} samples from ${labelsSet.size} runner labels in ${regionsSet.size} regions.`);

    // 2. Longest wait among that date's scheduled runs, when there are at least three.
    const dayRuns = runs.filter((r) => utcDate(r.slot) === date);
    if (dayRuns.length >= 3) {
      const byHour = new Map<number, number[]>();
      for (const r of dayRuns) {
        if (r.total === null) continue;
        const g = byHour.get(r.hour);
        if (g) g.push(r.total);
        else byHour.set(r.hour, [r.total]);
      }
      let bestHour = -1;
      let bestMed = -1;
      for (const h of [...byHour.keys()].sort((a, b) => a - b)) {
        const xs = sortAsc(byHour.get(h)!);
        const med = quantileSorted(xs, 0.5);
        if (med > bestMed) {
          bestMed = med;
          bestHour = h;
        }
      }
      if (bestHour >= 0) {
        sentences.push(
          `The longest wait came at ${pad2(bestHour)}:17 UTC, a median of ${formatDuration(bestMed)} before jobs started.`,
        );
      }
    }

    // 3. Missed slots that date.
    const e = coverage.expectedByDate.get(date) ?? 0;
    const m = e - (coverage.observedByDate.get(date) ?? 0);
    if (m > 0) sentences.push(`${m} of ${e} hourly sweeps did not arrive.`);

    // 4. Linux steal: daily p95 above 2% or above the trailing 14-day p90 of that label.
    for (const label of LINUX_LABELS) {
      const todays = ls.filter((s) => s.label === label && s.stealPct !== null).map((s) => s.stealPct as number);
      if (todays.length === 0) continue;
      const p95 = quantileSorted(sortAsc(todays), 0.95);
      const trailing: number[] = [];
      for (let k = 1; k <= 14; k++) {
        const d = addDays(date, -k);
        for (const s of byDate.get(d) ?? []) if (s.label === label && s.stealPct !== null) trailing.push(s.stealPct);
      }
      const trailP90 = trailing.length ? quantileSorted(sortAsc(trailing), 0.9) : null;
      if (p95 > 2 || (trailP90 !== null && p95 > trailP90)) {
        sentences.push(`Linux steal reached ${round(p95, 1)}% on ${label}.`);
      }
    }

    // 5. Image events that date.
    for (const lb of rollouts.byLabel) {
      for (const ev of lb.events) {
        if (ev.date === date) sentences.push(`${lb.label} moved to image ${ev.to}.`);
      }
    }

    // 6. Change points that date.
    for (const cp of rollouts.changePoints) {
      if (cp.date !== date) continue;
      const sign = cp.shiftPct >= 0 ? '+' : '-';
      sentences.push(
        `${SERIES_NAMES[cp.metric] ?? cp.metric} on ${cp.label} shifted ${sign}${Math.abs(cp.shiftPct).toFixed(1)}% from the previous segment.`,
      );
    }

    entries.push({ date, partial: date === last, text: sentences.join(' ') });
  }
  return entries.reverse();
}
