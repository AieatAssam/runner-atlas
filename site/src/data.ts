// Fetches rollup files once. A failed fetch is forgotten so the next call retries.
import type { Manifest, RollupName } from '../../shared/types/rollups.ts';
import type { RollupMap } from './types/views.ts';

const cache = new Map<string, Promise<unknown>>();

function url(file: string): string {
  return new URL(`data/rollups/${file}.json`, new URL(import.meta.env.BASE_URL, window.location.href)).href;
}

function fetchJson<T>(file: string): Promise<T> {
  const cached = cache.get(file);
  if (cached) return cached as Promise<T>;
  const pending = fetch(url(file)).then((res) => {
    if (!res.ok) throw new Error(`${file}.json returned ${res.status}`);
    return res.json() as Promise<T>;
  });
  pending.catch(() => cache.delete(file));
  cache.set(file, pending);
  return pending;
}

export function loadManifest(): Promise<Manifest> {
  return fetchJson<Manifest>('manifest');
}

export function loadRollup<N extends RollupName>(name: N): Promise<RollupMap[N]> {
  return fetchJson<RollupMap[N]>(name);
}
