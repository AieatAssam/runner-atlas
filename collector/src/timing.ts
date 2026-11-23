// Run and job timing (SPEC 3.6 Deadline, 3.7 Timing). Pure math plus one GitHub API lookup.
import type { RawSample } from '../../shared/types/sample.ts';

export type Timing = RawSample['timing'];

const API = 'https://api.github.com';
const HTTP_TIMEOUT_MS = 3000;

export const NULL_TIMING: Timing = {
  scheduledSlotIso: null, runCreatedAtIso: null, jobQueuedAtIso: null, jobStartedAtIso: null,
  cronDriftSec: null, queueTimeSec: null, totalDelaySec: null,
};

// Seconds with one decimal, as in the rollups.
function sec(ms: number): number {
  return Math.round(ms / 100) / 10;
}

// Latest HH:17:00Z at or before the run's creation time.
export function scheduledSlotIso(runCreatedIso: string): string {
  const created = Date.parse(runCreatedIso);
  const d = new Date(created);
  let slot = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 17, 0);
  if (slot > created) slot -= 3_600_000;
  return new Date(slot).toISOString();
}

export function cronDriftSec(runCreatedIso: string, slotIso: string): number {
  return sec(Math.max(0, Date.parse(runCreatedIso) - Date.parse(slotIso)));
}

export function queueTimeSec(queuedIso: string, startedIso: string): number {
  return sec(Date.parse(startedIso) - Date.parse(queuedIso));
}

export function totalDelaySec(startedIso: string, slotIso: string): number {
  return sec(Date.parse(startedIso) - Date.parse(slotIso));
}

// Pure assembly: schedule events get slot, drift and total delay; dispatch runs keep them null.
export function buildTiming(input: {
  event: 'schedule' | 'workflow_dispatch';
  runCreatedIso: string;
  jobQueuedIso: string;
  jobStartedIso: string;
}): Timing {
  const timing: Timing = {
    ...NULL_TIMING,
    runCreatedAtIso: input.runCreatedIso,
    jobQueuedAtIso: input.jobQueuedIso,
    jobStartedAtIso: input.jobStartedIso,
    queueTimeSec: queueTimeSec(input.jobQueuedIso, input.jobStartedIso),
  };
  if (input.event === 'schedule') {
    const slot = scheduledSlotIso(input.runCreatedIso);
    timing.scheduledSlotIso = slot;
    timing.cronDriftSec = cronDriftSec(input.runCreatedIso, slot);
    timing.totalDelaySec = totalDelaySec(input.jobStartedIso, slot);
  }
  return timing;
}

type FetchFn = typeof fetch;

async function getJson(url: string, token: string | undefined, fetchFn: FetchFn): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'runner-atlas-collector' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json();
}

function iso(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
}

// Looks up the run and this job by name. Any failure yields null timing, never a thrown error.
export async function fetchTiming(opts: {
  repo: string; runId: string; attempt: string; jobName: string; event: 'schedule' | 'workflow_dispatch';
  token?: string; fetchFn?: FetchFn;
}): Promise<Timing> {
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const run = (await getJson(`${API}/repos/${opts.repo}/actions/runs/${opts.runId}`, opts.token, fetchFn)) as { created_at?: unknown };
    const jobsUrl = `${API}/repos/${opts.repo}/actions/runs/${opts.runId}/attempts/${opts.attempt}/jobs?per_page=100`;
    const jobs = (await getJson(jobsUrl, opts.token, fetchFn)) as { jobs?: Array<{ name?: unknown; created_at?: unknown; started_at?: unknown }> };
    const job = jobs.jobs?.find((j) => j.name === opts.jobName);
    const runCreated = iso(run.created_at);
    const queued = iso(job?.created_at);
    const started = iso(job?.started_at);
    if (!runCreated || !queued || !started) return NULL_TIMING;
    return buildTiming({ event: opts.event, runCreatedIso: runCreated, jobQueuedIso: queued, jobStartedIso: started });
  } catch {
    return NULL_TIMING;
  }
}
