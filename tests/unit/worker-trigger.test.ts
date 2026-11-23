import { describe, expect, it } from 'vitest';
import worker, { isActiveStatus, parseDedupeMinutes, parseRepo, runTrigger, type TriggerEnv } from '../../workers/trigger/src/index.ts';

const NOW_MS = Date.parse('2026-11-23T19:17:00.000Z');
const SECRET_TOKEN = 'github_pat_test_secret_value_do_not_leak';

function baseEnv(overrides: Partial<TriggerEnv> = {}): TriggerEnv {
  return {
    GITHUB_TOKEN: SECRET_TOKEN,
    GITHUB_REPO: 'AieatAssam/runner-atlas',
    GITHUB_WORKFLOW: 'atlas.yml',
    GITHUB_REF: 'main',
    DEDUPE_WINDOW_MINUTES: '20',
    ENABLED: 'true',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('workers/trigger helpers', () => {
  it('validates owner/repo strings', () => {
    expect(parseRepo('AieatAssam/runner-atlas')).toEqual({ owner: 'AieatAssam', name: 'runner-atlas' });
    expect(() => parseRepo(undefined)).toThrow(/GITHUB_REPO/);
    expect(() => parseRepo('no-slash')).toThrow(/GITHUB_REPO/);
    expect(() => parseRepo('a/b/c')).toThrow(/GITHUB_REPO/);
    expect(() => parseRepo('../runner-atlas')).toThrow(/GITHUB_REPO/);
  });

  it('parses dedupe window minutes', () => {
    expect(parseDedupeMinutes(undefined)).toBe(20);
    expect(parseDedupeMinutes('')).toBe(20);
    expect(parseDedupeMinutes('0')).toBe(0);
    expect(parseDedupeMinutes('15')).toBe(15);
    expect(() => parseDedupeMinutes('-1')).toThrow(/DEDUPE_WINDOW_MINUTES/);
    expect(() => parseDedupeMinutes('abc')).toThrow(/DEDUPE_WINDOW_MINUTES/);
  });

  it('recognizes active GitHub Actions statuses', () => {
    for (const active of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
      expect(isActiveStatus(active)).toBe(true);
    }
    expect(isActiveStatus('completed')).toBe(false);
    expect(isActiveStatus(undefined)).toBe(false);
  });
});

describe('workers/trigger handler', () => {
  it('returns 404 for HTTP fetch requests', async () => {
    const res = await worker.fetch();
    expect(res.status).toBe(404);
  });

  it('dispatches workflow_dispatch with exact headers and payload when clear', async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body: string | null }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      if (calls.length === 1) {
        return jsonResponse({ workflow_runs: [] });
      }
      return new Response(null, { status: 204 });
    };

    const logs: string[] = [];
    const res = await runTrigger(baseEnv(), { fetchFn, nowMs: NOW_MS, log: (m) => logs.push(m) });
    expect(res).toEqual({
      action: 'dispatched',
      repo: 'AieatAssam/runner-atlas',
      workflow: 'atlas.yml',
      ref: 'main',
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('https://api.github.com/repos/AieatAssam/runner-atlas/actions/workflows/atlas.yml/runs?per_page=5');
    expect(calls[0].headers.get('Authorization')).toBe(`Bearer ${SECRET_TOKEN}`);
    expect(calls[0].headers.get('Accept')).toBe('application/vnd.github+json');
    expect(calls[0].headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
    expect(calls[0].headers.get('User-Agent')).toBe('runner-atlas-trigger');

    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toBe('https://api.github.com/repos/AieatAssam/runner-atlas/actions/workflows/atlas.yml/dispatches');
    expect(calls[1].headers.get('Content-Type')).toBe('application/json');
    expect(calls[1].body).toBe('{"ref":"main"}');
    expect(logs.join('\n')).not.toContain(SECRET_TOKEN);
  });

  it('skips with run_active when a run is queued or in_progress without dispatching', async () => {
    for (const status of ['in_progress', 'queued'] as const) {
      let postCalled = false;
      const fetchFn: typeof fetch = async (_input, init) => {
        if (init?.method === 'POST') postCalled = true;
        return jsonResponse({
          workflow_runs: [{ id: 12345, status, created_at: '2026-11-23T18:00:00Z' }],
        });
      };

      const res = await runTrigger(baseEnv(), { fetchFn, nowMs: NOW_MS, log: () => {} });
      expect(res).toEqual({ action: 'skipped', reason: 'run_active', runId: 12345 });
      expect(postCalled).toBe(false);
    }
  });

  it('skips with recent_run when a completed run is inside the dedupe window', async () => {
    let postCalled = false;
    const fetchFn: typeof fetch = async (_input, init) => {
      if (init?.method === 'POST') postCalled = true;
      return jsonResponse({
        workflow_runs: [{ id: 9876, status: 'completed', created_at: '2026-11-23T19:07:00.000Z' }],
      });
    };

    const res = await runTrigger(baseEnv(), { fetchFn, nowMs: NOW_MS, log: () => {} });
    expect(res).toEqual({ action: 'skipped', reason: 'recent_run', runId: 9876 });
    expect(postCalled).toBe(false);
  });

  it('dispatches when the latest completed run is older than DEDUPE_WINDOW_MINUTES or dedupe is 0', async () => {
    for (const dedupe of ['20', '0']) {
      const methods: string[] = [];
      const fetchFn: typeof fetch = async (_input, init) => {
        methods.push(init?.method ?? 'GET');
        if (init?.method === 'POST') return new Response(null, { status: 204 });
        const ageMinutes = dedupe === '0' ? 5 : 55;
        const createdIso = new Date(NOW_MS - ageMinutes * 60_000).toISOString();
        return jsonResponse({
          workflow_runs: [{ id: 555, status: 'completed', created_at: createdIso }],
        });
      };

      const res = await runTrigger(baseEnv({ DEDUPE_WINDOW_MINUTES: dedupe }), { fetchFn, nowMs: NOW_MS, log: () => {} });
      expect(res.action).toBe('dispatched');
      expect(methods).toEqual(['GET', 'POST']);
    }
  });

  it('fails open to dispatch on transient 503 or thrown error from GET runs', async () => {
    for (const mode of ['503', 'throw'] as const) {
      const methods: string[] = [];
      const warnings: string[] = [];
      const fetchFn: typeof fetch = async (_input, init) => {
        methods.push(init?.method ?? 'GET');
        if (init?.method === 'POST') return new Response(null, { status: 204 });
        if (mode === '503') return new Response('upstream error', { status: 503 });
        throw new Error('network timeout');
      };

      const res = await runTrigger(baseEnv(), { fetchFn, nowMs: NOW_MS, log: (m) => warnings.push(m) });
      expect(res.action).toBe('dispatched');
      expect(methods).toEqual(['GET', 'POST']);
      expect(warnings.some((w) => w.includes('proceeding to dispatch'))).toBe(true);
    }
  });

  it('fails loudly on 401/403 preflight errors and dispatch failures without leaking the token', async () => {
    for (const status of [401, 403]) {
      let postCalled = false;
      const fetchFn: typeof fetch = async (_input, init) => {
        if (init?.method === 'POST') postCalled = true;
        return new Response('Unauthorized', { status });
      };
      await expect(runTrigger(baseEnv(), { fetchFn, nowMs: NOW_MS, log: () => {} })).rejects.toThrow(`GitHub auth error ${status}`);
      expect(postCalled).toBe(false);
    }

    for (const status of [422, 500]) {
      const fetchFn: typeof fetch = async (_input, init) => {
        if (init?.method === 'POST') {
          return new Response('Workflow does not have workflow_dispatch', { status });
        }
        return jsonResponse({ workflow_runs: [] });
      };
      let caught: Error | null = null;
      try {
        await runTrigger(baseEnv(), { fetchFn, nowMs: NOW_MS, log: () => {} });
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught?.message).toContain(`GitHub dispatch failed (${status})`);
      expect(caught?.message).not.toContain(SECRET_TOKEN);
    }
  });

  it('skips immediately when ENABLED is false and rejects invalid configuration', async () => {
    let called = false;
    const fetchFn: typeof fetch = async () => {
      called = true;
      return new Response(null, { status: 204 });
    };

    const skipped = await runTrigger(baseEnv({ ENABLED: 'false' }), { fetchFn, nowMs: NOW_MS, log: () => {} });
    expect(skipped).toEqual({ action: 'skipped', reason: 'disabled' });
    expect(called).toBe(false);

    await expect(runTrigger(baseEnv({ GITHUB_TOKEN: '   ' }), { fetchFn, log: () => {} })).rejects.toThrow(/GITHUB_TOKEN/);
    await expect(runTrigger(baseEnv({ GITHUB_REPO: 'invalid' }), { fetchFn, log: () => {} })).rejects.toThrow(/GITHUB_REPO/);
    await expect(runTrigger(baseEnv({ GITHUB_WORKFLOW: '../evil.yml' }), { fetchFn, log: () => {} })).rejects.toThrow(/GITHUB_WORKFLOW/);
  });
});
