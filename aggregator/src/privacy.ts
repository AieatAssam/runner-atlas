// Privacy scan (SPEC 3.1): rejects any key or string value holding a bare IPv4/IPv6 address or a /32 or /128 range.
// Defence in depth behind the schema's per-field patterns. Reasons name the path only, never the matched text.
import { isIPv4, isIPv6 } from 'node:net';

// IPv6 candidates: runs of hex digits, colons and dots (with an optional /prefix and %zone).
const V6 = /[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?:%[0-9A-Za-z]+)?(?:\/\d+)?/g;
// IPv4 candidates: dotted quads not inside a longer dotted number, optional /prefix.
const V4 = /(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])(?:\/(\d+))?/g;

// Decodes each run of %XX escapes on its own, so one stray % cannot stop the rest from decoding.
const decodeRuns = (t: string): string =>
  t.replace(/(%[0-9A-Fa-f]{2})+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });

function hitIn(text: string): boolean {
  // Every intermediate form is scanned: raw, then alternating NFKC and percent-decoding until stable (max 4 rounds).
  const forms = new Set([text]);
  let cur = text;
  for (let i = 0; i < 4; i++) {
    const next = decodeRuns(cur.normalize('NFKC'));
    forms.add(cur.normalize('NFKC'));
    forms.add(next);
    if (next === cur) break;
    cur = next;
  }
  for (const f of forms) {
    for (const m of f.matchAll(V4)) {
      if (isIPv4(m[1]) && (m[2] === undefined || m[2] === '32')) return true;
    }
    for (const [tok] of f.matchAll(V6)) {
      const slash = tok.indexOf('/');
      const addr = (slash === -1 ? tok : tok.slice(0, slash)).split('%')[0];
      const prefix = slash === -1 ? null : tok.slice(slash + 1);
      if (isIPv6(addr) && (prefix === null || prefix === '128')) return true;
    }
  }
  return false;
}

// null when clean, otherwise the JSON path of the first offending key or string.
export function privacyScanError(value: unknown, path = '$'): string | null {
  if (typeof value === 'string') return hitIn(value) ? `${path} holds an IP address or host range` : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = privacyScanError(value[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (hitIn(k)) return `${path} has a key holding an IP address`;
      const r = privacyScanError(v, `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}
