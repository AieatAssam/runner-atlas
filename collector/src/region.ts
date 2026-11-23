// Region and VM size (SPEC 3.4). The egress IP lives only in a local variable and is never logged or stored.
import { readFileSync } from 'node:fs';
import type { RawSample } from '../../shared/types/sample.ts';

export type Place = RawSample['place'];
export type FetchFn = typeof fetch;

const IMDS_URL = 'http://169.254.169.254/metadata/instance?api-version=2021-02-01';
const TRACE_URL = 'https://1.1.1.1/cdn-cgi/trace';
const META_URL = 'https://api.github.com/meta';
const IMDS_TIMEOUT_MS = 2000;
const TRACE_TIMEOUT_MS = 2000;
const META_TIMEOUT_MS = 3000;

export interface CidrEntry { cidr: string; region: string | null }

type ParsedIp = { family: 4 | 6; value: bigint };

function parseV4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((acc, p) => (acc << 8n) | BigInt(Number(p)), 0n);
}

function parseV6(s: string): bigint | null {
  let str = s;
  const last = str.lastIndexOf(':');
  const tail = str.slice(last + 1);
  if (tail.includes('.')) {
    const v4 = parseV4(tail);
    if (v4 === null) return null;
    str = `${str.slice(0, last + 1)}${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<string>(fill).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

// Null for anything that is not an IP literal. Callers never echo the input.
export function parseIp(text: string): ParsedIp | null {
  if (text.includes(':')) {
    const value = parseV6(text);
    return value === null ? null : { family: 6, value };
  }
  const value = parseV4(text);
  return value === null ? null : { family: 4, value };
}

// Parses `a.b.c.d/n` or `v6/n`. Rejects prefixes at or beyond the host length (/32, /128).
export function parseCidr(cidr: string): { family: 4 | 6; net: bigint; prefix: number } | null {
  const [addr, len, extra] = cidr.split('/');
  if (extra !== undefined || len === undefined || !/^\d{1,3}$/.test(len)) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const bits = ip.family === 4 ? 32 : 128;
  const prefix = Number(len);
  if (prefix >= bits) return null;
  return { family: ip.family, net: ip.value >> BigInt(bits - prefix), prefix };
}

export function cidrContains(ip: ParsedIp, cidr: { family: 4 | 6; net: bigint; prefix: number }): boolean {
  if (ip.family !== cidr.family) return false;
  const bits = ip.family === 4 ? 32 : 128;
  return ip.value >> BigInt(bits - cidr.prefix) === cidr.net;
}

// Longest-prefix match. Entries with an invalid or /32 (/128) range are ignored. Ties keep the first entry.
export function longestMatch(ip: string, entries: CidrEntry[]): CidrEntry | null {
  const parsed = parseIp(ip);
  if (!parsed) return null;
  let best: CidrEntry | null = null;
  let bestPrefix = -1;
  for (const entry of entries) {
    const cidr = parseCidr(entry.cidr);
    if (!cidr || cidr.prefix <= bestPrefix || !cidrContains(parsed, cidr)) continue;
    best = entry;
    bestPrefix = cidr.prefix;
  }
  return best;
}

// IMDS: one GET. Only compute.location and compute.vmSize are kept.
export async function fetchImds(fetchFn: FetchFn = fetch, timeoutMs = IMDS_TIMEOUT_MS): Promise<{ imdsStatus: Place['imdsStatus']; region: string | null; vmSize: string | null }> {
  const unreachable = { imdsStatus: 'unreachable' as const, region: null, vmSize: null };
  try {
    const res = await fetchFn(IMDS_URL, { headers: { Metadata: 'true' }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return unreachable;
    const body = (await res.json()) as { compute?: { location?: unknown; vmSize?: unknown } };
    const str = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null);
    return { imdsStatus: 'reachable', region: str(body.compute?.location), vmSize: str(body.compute?.vmSize) };
  } catch {
    return unreachable;
  }
}

// Cloudflare trace: only the `ip=` line is read. Returns null when absent or not an IP.
export function parseTraceIp(text: string): string | null {
  const m = text.match(/^ip=(\S+)$/m);
  return m && parseIp(m[1]) ? m[1] : null;
}

// Curated table: { cidr, region, provider, source } entries. Read once per run.
export function loadRegionTable(): CidrEntry[] {
  const raw = readFileSync(new URL('../data/region-cidrs.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as Array<{ cidr: string; region: string }>).map((e) => ({ cidr: e.cidr, region: e.region }));
}

async function fetchMetaRanges(token: string | undefined, fetchFn: FetchFn): Promise<CidrEntry[]> {
  try {
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'runner-atlas-collector' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchFn(META_URL, { headers, signal: AbortSignal.timeout(META_TIMEOUT_MS) });
    if (!res.ok) return [];
    const body = (await res.json()) as { actions?: unknown; actions_macos?: unknown };
    const ranges = [...(Array.isArray(body.actions) ? body.actions : []), ...(Array.isArray(body.actions_macos) ? body.actions_macos : [])];
    return ranges.filter((r): r is string => typeof r === 'string').map((cidr) => ({ cidr, region: null }));
  } catch {
    return [];
  }
}

// Only when IMDS is unreachable. Table entries come first so a tie on prefix keeps the region.
export async function inferFromEgress(opts: { token?: string; fetchFn?: FetchFn; table?: CidrEntry[] }): Promise<Pick<Place, 'method' | 'matchedCidr' | 'inferredRegion'>> {
  const fetchFn = opts.fetchFn ?? fetch;
  const none = { method: 'none' as const, matchedCidr: null, inferredRegion: null };
  try {
    const trace = await fetchFn(TRACE_URL, { signal: AbortSignal.timeout(TRACE_TIMEOUT_MS) });
    if (!trace.ok) return none;
    const egress = parseTraceIp(await trace.text());
    if (!egress) return none;
    const table = opts.table ?? loadRegionTable();
    const meta = await fetchMetaRanges(opts.token, fetchFn);
    const hit = longestMatch(egress, [...table, ...meta]);
    if (!hit) return none;
    return { method: 'cidr', matchedCidr: hit.cidr, inferredRegion: hit.region };
  } catch {
    return none;
  }
}

// Full placement: IMDS first, egress inference only on failure.
export async function readPlacement(opts: { token?: string; fetchFn?: FetchFn; table?: CidrEntry[] } = {}): Promise<Place> {
  const imds = await fetchImds(opts.fetchFn);
  if (imds.imdsStatus === 'reachable') {
    return { ...imds, inferredRegion: null, matchedCidr: null, method: 'imds' };
  }
  const inferred = await inferFromEgress(opts);
  return { ...imds, ...inferred };
}
