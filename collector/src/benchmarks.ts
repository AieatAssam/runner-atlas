// Micro-benchmarks under a hard 20 000 ms budget (SPEC 3.6).
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { RawSample } from '../../shared/types/sample.ts';
import { runKernel } from './bench-worker.ts';

export type Bench = RawSample['bench'];
type Step = Bench['truncated'][number];
export type FetchFn = typeof fetch;

export const TOTAL_BUDGET_MS = 20_000;
export const MIN_STEP_MS = 200;
const RESERVE_MS = 250;
const PROBE_BYTES = 1_048_576;
const MIB = 1024 * 1024;

// One ceiling for the whole run. budget() gives a step min(cap, time left - 250 ms reserve).
export class Deadline {
  endMs: number;

  constructor(startMs: number, totalMs: number) {
    this.endMs = startMs + totalMs;
  }

  budget(capMs: number, nowMs: number): number {
    return Math.min(capMs, this.endMs - nowMs - RESERVE_MS);
  }
}

const round = (x: number, digits: number): number => Math.round(x * 10 ** digits) / 10 ** digits;

// Mops/s of one kernel window (ops / 1e6 / seconds).
function mops(ops: number, ms: number): number {
  return (ops / 1e6) / (ms / 1000);
}

export function singleCore(budgetMs: number): number | null {
  const r = runKernel(Math.min(2300, budgetMs));
  return r.ms > 0 ? round(mops(r.ops, r.ms), 2) : null;
}

// Resolves with the next message of `type`, or null on error or timeout.
function nextMessage<T>(worker: Worker, type: string, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    if (timeoutMs <= 0) {
      resolve(null);
      return;
    }
    const finish = (value: T | null) => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      resolve(value);
    };
    const onMessage = (msg: { type?: string }) => {
      if (msg?.type === type) finish(msg as T);
    };
    const onError = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    worker.on('message', onMessage);
    worker.on('error', onError);
  });
}

export async function multiCore(budgetMs: number): Promise<number | null> {
  const hardEnd = performance.now() + budgetMs;
  const workers = Array.from({ length: availableParallelism() }, () => new Worker(new URL('./bench-worker.ts', import.meta.url)));
  try {
    const ready = await Promise.all(workers.map((w) => nextMessage<{ type: string }>(w, 'ready', hardEnd - performance.now())));
    if (ready.some((r) => r === null)) return null;
    const windowMs = Math.min(3000, hardEnd - performance.now() - 150);
    if (windowMs < MIN_STEP_MS) return null;
    const done = await Promise.all(workers.map((w) => {
      const result = nextMessage<{ ops: number; ms: number }>(w, 'done', hardEnd - performance.now());
      w.postMessage({ type: 'go', windowMs });
      return result;
    }));
    if (done.some((r) => r === null || r.ms <= 0)) return null;
    return round(done.reduce((sum, r) => sum + mops(r!.ops, r!.ms), 0), 2);
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

function mbps(bytes: number, ms: number): number | null {
  return ms > 0 ? round((bytes / MIB) / (ms / 1000), 1) : null;
}

// Write up to 128 MiB (stop at 40% of the budget), fsync, read back and compare, unlink in finally.
export function diskStep(budgetMs: number, dir = tmpdir()): { seqWriteMBs: number | null; seqReadMBs: number | null } | null {
  const path = join(dir, `atlas-${process.pid}.bin`);
  const chunk = randomBytes(4 * MIB);
  let fd = -1;
  try {
    fd = openSync(path, 'w+');
    let written = 0;
    const tw = performance.now();
    while (written < 128 * MIB && performance.now() - tw < 0.4 * budgetMs) {
      writeSync(fd, chunk, 0, chunk.length, written);
      written += chunk.length;
    }
    fsyncSync(fd);
    const writeMs = performance.now() - tw;
    if (written === 0) return null;

    const buf = Buffer.alloc(chunk.length);
    let read = 0;
    const tr = performance.now();
    while (read < written && performance.now() - tr < 0.5 * budgetMs) {
      const n = readSync(fd, buf, 0, chunk.length, read);
      if (n !== chunk.length || !buf.equals(chunk)) return null;
      read += n;
    }
    if (read === 0) return null;
    return { seqWriteMBs: mbps(written, writeMs), seqReadMBs: mbps(read, performance.now() - tr) };
  } catch {
    return null;
  } finally {
    if (fd >= 0) closeSync(fd);
    rmSync(path, { force: true });
  }
}

// 64 MiB Float64Array copies plus a sum reduction. Counts bytes read and written over the window.
export function memStep(budgetMs: number): number | null {
  const n = (64 * MIB) / 8;
  const a = new Float64Array(n).fill(1.5);
  const b = new Float64Array(n);
  const windowMs = Math.min(2300, budgetMs);
  const t0 = performance.now();
  let iters = 0;
  let sink = 0;
  while (performance.now() - t0 < windowMs) {
    b.set(a);
    for (let i = 0; i < n; i++) sink += b[i];
    iters++;
  }
  const ms = performance.now() - t0;
  if (iters === 0 || ms <= 0 || !Number.isFinite(sink)) return null;
  const bytesPerIter = 3 * 64 * MIB; // set: read + write; sum: read
  return round((iters * bytesPerIter) / 1e9 / (ms / 1000), 2);
}

const median = (xs: number[]): number => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];

// Network: 5 sequential zen GETs (TTFB median), then one throughput GET. Repo probe first, meta as fallback.
export async function netStep(opts: {
  budgetMs: number; env: Record<string, string | undefined>; fetchFn?: FetchFn;
}): Promise<{ netTtfbMs: number | null; netMbps: number | null; netProbe: 'repo' | 'meta' | null; budgetCut: boolean }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const netEnd = performance.now() + opts.budgetMs;
  const remaining = () => Math.max(1, Math.floor(netEnd - performance.now()));
  const token = opts.env.GITHUB_TOKEN;
  const baseHeaders = (auth: boolean): Record<string, string> => {
    const h: Record<string, string> = { 'accept-encoding': 'identity', 'user-agent': 'runner-atlas-collector' };
    if (auth && token) h.authorization = `Bearer ${token}`;
    return h;
  };

  const ttfbs: number[] = [];
  for (let i = 0; i < 5 && remaining() > 1; i++) {
    try {
      const t = performance.now();
      const res = await fetchFn('https://api.github.com/zen', { headers: baseHeaders(true), signal: AbortSignal.timeout(remaining()) });
      const head = performance.now() - t;
      if (res.ok && !res.headers.has('content-encoding')) {
        await res.text();
        ttfbs.push(head);
      } else {
        await res.body?.cancel();
      }
    } catch {
      // a failed attempt is simply not counted
    }
  }

  const probe = async (url: string, expect: (bytes: number) => boolean): Promise<number | null> => {
    try {
      const res = await fetchFn(url, { headers: baseHeaders(false), signal: AbortSignal.timeout(remaining()) });
      if (res.status !== 200 || res.headers.has('content-encoding')) {
        await res.body?.cancel();
        return null;
      }
      const tHead = performance.now();
      const bytes = (await res.arrayBuffer()).byteLength;
      const tEnd = performance.now();
      if (!expect(bytes) || tEnd <= tHead) return null;
      return round((bytes * 8) / 1e6 / ((tEnd - tHead) / 1000), 1);
    } catch {
      return null;
    }
  };

  let netMbps: number | null = null;
  let netProbe: 'repo' | 'meta' | null = null;
  const repo = opts.env.GITHUB_REPOSITORY;
  const sha = opts.env.GITHUB_SHA;
  if (repo && sha && remaining() > 1) {
    netMbps = await probe(`https://raw.githubusercontent.com/${repo}/${sha}/collector/fixtures/probe-1mib.bin`, (b) => b === PROBE_BYTES);
    if (netMbps !== null) netProbe = 'repo';
  }
  if (netMbps === null && remaining() > 1) {
    netMbps = await probe('https://api.github.com/meta', (b) => b > 0);
    if (netMbps !== null) netProbe = 'meta';
  }
  return {
    netTtfbMs: ttfbs.length > 0 ? round(median(ttfbs), 1) : null,
    netMbps,
    netProbe,
    budgetCut: remaining() <= 1 && netMbps === null,
  };
}

// Runs the five steps in order. Each step that yields nothing is named in `truncated`.
export async function runBenchmarks(opts: { env: Record<string, string | undefined>; fetchFn?: FetchFn; tmpDir?: string }): Promise<Bench> {
  const t0 = performance.now();
  const deadline = new Deadline(t0, TOTAL_BUDGET_MS);
  const truncated: Step[] = [];
  const budgetFor = (name: Step, capMs: number): number => {
    const b = deadline.budget(capMs, performance.now());
    if (b < MIN_STEP_MS) {
      truncated.push(name);
      return 0;
    }
    return b;
  };

  let singleCoreScore: number | null = null;
  let multiCoreScore: number | null = null;
  let seqWriteMBs: number | null = null;
  let seqReadMBs: number | null = null;
  let memBandwidthGBs: number | null = null;
  let net = { netTtfbMs: null as number | null, netMbps: null as number | null, netProbe: null as 'repo' | 'meta' | null };

  let b = budgetFor('single', 2500);
  if (b > 0) {
    singleCoreScore = singleCore(b);
    if (singleCoreScore === null) truncated.push('single');
  }

  b = budgetFor('multi', 3500);
  if (b > 0) {
    multiCoreScore = await multiCore(b);
    if (multiCoreScore === null) truncated.push('multi');
  }

  b = budgetFor('disk', 6000);
  if (b > 0) {
    const d = diskStep(b, opts.tmpDir);
    seqWriteMBs = d?.seqWriteMBs ?? null;
    seqReadMBs = d?.seqReadMBs ?? null;
    if (seqWriteMBs === null || seqReadMBs === null) truncated.push('disk');
  }

  b = budgetFor('mem', 2500);
  if (b > 0) {
    memBandwidthGBs = memStep(b);
    if (memBandwidthGBs === null) truncated.push('mem');
  }

  b = budgetFor('net', 4500);
  if (b > 0) {
    const r = await netStep({ budgetMs: b, env: opts.env, fetchFn: opts.fetchFn });
    net = { netTtfbMs: r.netTtfbMs, netMbps: r.netMbps, netProbe: r.netProbe };
    if (r.budgetCut) truncated.push('net');
  }

  const benchmarkDurationMs = Math.round(performance.now() - t0);
  if (benchmarkDurationMs > TOTAL_BUDGET_MS) throw new Error(`benchmark exceeded ${TOTAL_BUDGET_MS} ms`);
  return {
    benchmarkDurationMs,
    singleCoreScore,
    multiCoreScore,
    seqWriteMBs,
    seqReadMBs,
    memBandwidthGBs,
    netTtfbMs: net.netTtfbMs,
    netMbps: net.netMbps,
    netProbe: net.netProbe,
    truncated,
  };
}
