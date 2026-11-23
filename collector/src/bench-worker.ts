// Integer kernel shared by the single-core step and the worker_threads multi-core step (SPEC 3.6).
import { isMainThread, parentPort } from 'node:worker_threads';

const BATCH = 1 << 16;
let sink = 0; // keeps the optimizer from discarding the loop

// xorshift32 plus an integer multiply-add per iteration, in batches, until windowMs has elapsed.
export function runKernel(windowMs: number): { ops: number; ms: number } {
  let x = 0x2545f491;
  let acc = 0;
  let ops = 0;
  const start = performance.now();
  for (;;) {
    for (let i = 0; i < BATCH; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      acc = (Math.imul(x, 0x9e3779b1) + acc) | 0;
    }
    ops += BATCH;
    const ms = performance.now() - start;
    if (ms >= windowMs) {
      sink = acc;
      return { ops, ms };
    }
  }
}

// Worker protocol: post {type:'ready'}; on {type:'go', windowMs} run and post {type:'done', ops, ms}.
if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on('message', (msg: { type: string; windowMs?: number }) => {
    if (msg.type === 'go') port.postMessage({ type: 'done', ...runKernel(msg.windowMs ?? 0) });
  });
  port.postMessage({ type: 'ready' });
}
