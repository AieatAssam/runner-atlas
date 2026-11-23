// Pure text formatting shared by the prerender (vite.config.ts) and the browser shell. No DOM access.
import type { ConfidenceTier, SlotScore, TierId } from '../../../shared/types/rollups.ts';

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export const SWEEP_MINUTE = 17;

export function groupDigits(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatDuration(sec: number): string {
  const total = Math.round(sec);
  if (total < 60) return `${total} s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m} min` : `${m} min ${s} s`;
}

export function formatInterval(lo: number, hi: number): string {
  if (Math.round(hi) < 60) return `${Math.round(lo)} to ${Math.round(hi)} s`;
  return `${formatDuration(lo)} to ${formatDuration(hi)}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

export function formatSlot(weekday: number | null, hourUtc: number): string {
  const clock = `${pad2(hourUtc)}:${pad2(SWEEP_MINUTE)} UTC`;
  return weekday === null ? clock : `${WEEKDAYS[weekday] ?? 'Unknown day'} ${clock}`;
}

export function formatRange(range: { from: string; to: string } | null): string {
  return range ? `${range.from} to ${range.to}` : 'No samples yet';
}

export function formatCountCaption(samples: number, runs: number): string {
  return `n = ${groupDigits(samples)} samples (${groupDigits(runs)} runs)`;
}

export function slotSentence(label: 'Best' | 'Worst', slot: SlotScore): string {
  return `${label} observed slot: ${formatSlot(slot.weekday, slot.hourUtc)}, wait score ${formatDuration(slot.score)} (95% interval ${formatInterval(slot.ci95[0], slot.ci95[1])}).`;
}

export function confidenceSentence(tier: ConfidenceTier, surveyDay: number): string {
  const days = surveyDay === 1 ? '1 day' : `${surveyDay} days`;
  return `Confidence: ${tier}, ${days} of sweeps.`;
}

export interface TierStatusInput { id: TierId; minDays: number; minSamples: number; samplesNeeded: number; daysNeeded: number; opensOn: string | null }

export function tierChartingText(t: TierStatusInput): string {
  const parts: string[] = [];
  if (t.samplesNeeded > 0) parts.push(`${groupDigits(t.samplesNeeded)} more ${t.samplesNeeded === 1 ? 'sample' : 'samples'}`);
  if (t.daysNeeded > 0) parts.push(`${t.daysNeeded} more ${t.daysNeeded === 1 ? 'day' : 'days'}`);
  if (parts.length === 0) return 'Charting in progress.';
  return `${parts.join(' and ')} needed.`;
}

export function tierExpectedText(t: TierStatusInput): string {
  return t.opensOn ? `Expected on survey day ${t.minDays}, about ${t.opensOn}.` : 'Expected once the sample count is reached.';
}

// Next HH:17 UTC strictly after `now`.
export function nextSweep(now: Date): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), SWEEP_MINUTE, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

export function formatSweepClock(d: Date): string {
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

// Locked ("Charting in progress") body. Same markup in the prerender and the browser.
export function lockedMarkup(t: TierStatusInput & { samples: number; surveyDay: number }): string {
  const samplesDone = Math.max(0, Math.min(t.minSamples, t.samples));
  const daysDone = Math.max(0, Math.min(t.minDays, t.surveyDay));
  return [
    '<div class="locked">',
    '<span class="plate-map plate-graticule" aria-hidden="true"></span>',
    '<p class="locked__title">Charting in progress</p>',
    `<p class="locked__text">${tierChartingText(t)}</p>`,
    `<p class="locked__text">${tierExpectedText(t)}</p>`,
    '<div class="locked__bars">',
    `<label class="locked__bar">Samples <progress value="${samplesDone}" max="${t.minSamples}"></progress></label>`,
    `<label class="locked__bar">Days <progress value="${daysDone}" max="${t.minDays}"></progress></label>`,
    '</div>',
    '</div>',
  ].join('');
}
