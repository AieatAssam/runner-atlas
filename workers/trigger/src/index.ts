export interface TriggerEnv {
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  GITHUB_WORKFLOW?: string;
  GITHUB_REF?: string;
  DEDUPE_WINDOW_MINUTES?: string;
  ENABLED?: string;
}

export interface ScheduledEventLike {
  cron: string;
  scheduledTime: number;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export type TriggerResult =
  | { action: 'skipped'; reason: 'disabled' }
  | { action: 'skipped'; reason: 'run_active' | 'recent_run'; runId?: number }
  | { action: 'dispatched'; repo: string; workflow: string; ref: string };

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'runner-atlas-trigger';
const REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_DEDUPE_MINUTES = 20;
const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

interface WorkflowRunItem {
  id?: number;
  status?: string;
  created_at?: string;
}

interface RunsPayload {
  workflow_runs?: WorkflowRunItem[];
}

export function parseRepo(repo: string | undefined): { owner: string; name: string } {
  const trimmed = repo?.trim() ?? '';
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error('Invalid GITHUB_REPO: expected "owner/name"');
  }
  const [owner, name] = trimmed.split('/');
  if (owner === '.' || owner === '..' || name === '.' || name === '..') {
    throw new Error('Invalid GITHUB_REPO: expected "owner/name"');
  }
  return { owner, name };
}

export function parseDedupeMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_DEDUPE_MINUTES;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('Invalid DEDUPE_WINDOW_MINUTES: expected a non-negative number');
  }
  return parsed;
}

export function isActiveStatus(status: string | undefined): boolean {
  return typeof status === 'string' && ACTIVE_STATUSES.has(status);
}

export async function runTrigger(
  env: TriggerEnv,
  opts?: { fetchFn?: typeof fetch; nowMs?: number; log?: (msg: string) => void },
): Promise<TriggerResult> {
  if (env.ENABLED !== undefined && env.ENABLED.trim().toLowerCase() !== 'true') {
    return { action: 'skipped', reason: 'disabled' };
  }

  const token = env.GITHUB_TOKEN?.trim() ?? '';
  if (!token) {
    throw new Error('GITHUB_TOKEN secret is not set');
  }

  const { owner, name } = parseRepo(env.GITHUB_REPO);
  const workflow = (env.GITHUB_WORKFLOW ?? 'atlas.yml').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(workflow) || workflow === '.' || workflow === '..') {
    throw new Error('Invalid GITHUB_WORKFLOW');
  }

  const ref = (env.GITHUB_REF ?? 'main').trim();
  if (!ref) {
    throw new Error('GITHUB_REF must not be empty');
  }

  const dedupeMinutes = parseDedupeMinutes(env.DEDUPE_WINDOW_MINUTES);
  const fetchFn = opts?.fetchFn ?? fetch;
  const nowMs = opts?.nowMs ?? Date.now();
  const log = opts?.log ?? ((msg: string) => console.log(msg));

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': USER_AGENT,
  };

  const runsUrl = `${API_BASE}/repos/${owner}/${name}/actions/workflows/${workflow}/runs?per_page=5`;
  let runsRes: Response | null = null;
  try {
    runsRes = await fetchFn(runsUrl, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network error';
    log(`preflight runs check failed (${message}); proceeding to dispatch`);
  }

  if (runsRes !== null) {
    if (runsRes.status === 401 || runsRes.status === 403) {
      throw new Error(`GitHub auth error ${runsRes.status} while checking recent runs`);
    }

    if (runsRes.ok) {
      let payload: RunsPayload | null = null;
      try {
        payload = (await runsRes.json()) as RunsPayload;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'invalid JSON';
        log(`preflight JSON parse failed (${message}); proceeding to dispatch`);
      }

      const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
      const active = runs.find((run) => isActiveStatus(run.status));
      if (active) {
        return active.id !== undefined
          ? { action: 'skipped', reason: 'run_active', runId: active.id }
          : { action: 'skipped', reason: 'run_active' };
      }

      if (dedupeMinutes > 0) {
        const windowMs = dedupeMinutes * 60_000;
        const recent = runs.find((run) => {
          if (typeof run.created_at !== 'string') return false;
          const createdMs = Date.parse(run.created_at);
          if (Number.isNaN(createdMs)) return false;
          const ageMs = nowMs - createdMs;
          return ageMs >= -60_000 && ageMs < windowMs;
        });
        if (recent) {
          return recent.id !== undefined
            ? { action: 'skipped', reason: 'recent_run', runId: recent.id }
            : { action: 'skipped', reason: 'recent_run' };
        }
      }
    } else {
      log(`preflight runs check returned HTTP ${runsRes.status}; proceeding to dispatch`);
    }
  }

  const dispatchUrl = `${API_BASE}/repos/${owner}/${name}/actions/workflows/${workflow}/dispatches`;
  const dispatchRes = await fetchFn(dispatchUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (dispatchRes.status === 204 || dispatchRes.ok) {
    log(`dispatched ${owner}/${name} (${workflow}@${ref})`);
    return { action: 'dispatched', repo: `${owner}/${name}`, workflow, ref };
  }

  const rawBody = await dispatchRes.text().catch(() => '');
  const snippet = rawBody.replace(/\s+/g, ' ').trim().slice(0, 200);
  throw new Error(`GitHub dispatch failed (${dispatchRes.status})${snippet ? `: ${snippet}` : ''}`);
}

export default {
  async fetch(): Promise<Response> {
    return new Response('Not Found', { status: 404 });
  },

  async scheduled(_event: ScheduledEventLike, env: TriggerEnv, ctx: ExecutionContextLike): Promise<void> {
    const work = runTrigger(env).then((res) => console.log(JSON.stringify(res)));
    ctx.waitUntil(work);
    await work;
  },
};
