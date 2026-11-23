import { describe, expect, it } from 'vitest';
import { buildDrift, headlineFor, scheduleRuns, scheduleSamples, slotCoverage } from '../../aggregator/src/drift.ts';
import { makeCtx } from '../../aggregator/src/summary.ts';
import { sortSamples } from '../../aggregator/src/common.ts';
import { generate } from '../../scripts/synthetic/generate.ts';

const START = '2026-09-01';
const oneDay = () => sortSamples(generate({ days: 1, seed: 7, start: START }));

describe('scheduleSamples', () => {
  it('keeps only scheduled samples that carry a slot', () => {
    const all = oneDay();
    const sched = scheduleSamples(all);
    expect(sched.length).toBeGreaterThan(0);
    expect(sched.length).toBe(all.length);
    for (const s of sched) {
      expect(s.event).toBe('schedule');
      expect(s.timing.scheduledSlotIso).not.toBeNull();
    }
    const noSlot = { ...all[0], event: 'local' as const, timing: { ...all[0].timing, scheduledSlotIso: null } };
    expect(scheduleSamples([noSlot as typeof all[0]])).toEqual([]);
  });
});

describe('scheduleRuns and slotCoverage', () => {
  it('groups one run per slot and counts 11 jobs per run', () => {
    const runs = scheduleRuns(scheduleSamples(oneDay()));
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(r.samples).toBe(11);
  });

  it('observed never exceeds expected, and a one-day survey expects 24 slots', () => {
    const cov = slotCoverage(scheduleSamples(oneDay()));
    expect(cov.expected).toBe(24);
    expect(cov.observed).toBeLessThanOrEqual(cov.expected);
    expect(cov.observed).toBeGreaterThan(0);
    expect(cov.missedByHour).toHaveLength(24);
  });

  it('counts a missing sweep as expected but not observed', () => {
    const full = scheduleSamples(oneDay());
    const hour = 12;
    const withGap = full.filter((s) => !s.timing.scheduledSlotIso!.includes(`T${String(hour).padStart(2, '0')}:17`));
    const cov = slotCoverage(withGap);
    expect(cov.expected).toBe(24);
    expect(cov.observed).toBe(23);
    expect(cov.missedByHour[hour]).toBe(1);
  });
});

describe('headline', () => {
  it('reports no samples yet for an empty survey', () => {
    const ctx = makeCtx([]);
    const drift = buildDrift(ctx);
    const h = headlineFor(ctx, drift, 0);
    expect(h.tier).toBe('insufficient');
    expect(h.reason).toBe('no samples yet');
  });

  it('reports fewer than 3 survey days for a one-day survey', () => {
    const ctx = makeCtx(oneDay());
    const h = headlineFor(ctx, buildDrift(ctx), 1);
    expect(h.tier).toBe('insufficient');
    expect(h.reason).toBe('fewer than 3 survey days');
  });
});
