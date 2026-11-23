// Progressive tiers (SPEC 5). Pure: the caller supplies sample count, survey day and first sample date.
import type { Manifest } from '../../shared/types/rollups.ts';
import { addDays } from './common.ts';

type TierRow = Manifest['tiers'][number];

export const TIER_RULES: ReadonlyArray<Pick<TierRow, 'id' | 'minDays' | 'minSamples'>> = [
  { id: 'day1', minDays: 1, minSamples: 5 },
  { id: 'day3', minDays: 3, minSamples: 120 },
  { id: 'day7', minDays: 7, minSamples: 500 },
  { id: 'day14', minDays: 14, minSamples: 1200 },
  { id: 'day30', minDays: 30, minSamples: 3000 },
  { id: 'day90', minDays: 90, minSamples: 9000 },
];

export function evaluateTiers(samples: number, surveyDay: number, firstDate: string | null): TierRow[] {
  return TIER_RULES.map((rule) => {
    const samplesNeeded = Math.max(0, rule.minSamples - samples);
    const daysNeeded = Math.max(0, rule.minDays - surveyDay);
    const status: TierRow['status'] = samplesNeeded === 0 && daysNeeded === 0 ? 'open' : 'charting';
    // Forecast a date only when samples are already enough and only days are short (SPEC 5).
    const opensOn = samplesNeeded === 0 && daysNeeded > 0 && firstDate !== null
      ? addDays(firstDate, rule.minDays - 1)
      : null;
    return { ...rule, status, samplesNeeded, daysNeeded, opensOn };
  });
}
