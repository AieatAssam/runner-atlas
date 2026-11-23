// Privacy scanner (SPEC 3.1): flags IP literals, secrets and home paths in a serialized sample.
// The IP patterns are copied from schemas/raw-sample.schema.json (free-text fields).

const IPV4 = /(^|[^0-9.])(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}([^0-9.]|$)/;
const IPV6 = /(^|[^0-9A-Za-z:])[0-9A-Fa-f]{0,4}(:[0-9A-Fa-f]{0,4}){2,7}([^0-9A-Za-z:]|$)/;

// Fields whose values are structured by design (timestamps, ids, CIDRs) and so are not free text.
const STRUCTURED_KEYS = new Set([
  'id', 'collectedAtIso', 'scheduledSlotIso', 'runCreatedAtIso', 'jobQueuedAtIso', 'jobStartedAtIso', 'matchedCidr',
]);

export interface ScanOptions {
  secrets?: string[];   // exact values that must never appear (e.g. GITHUB_TOKEN)
  homeDir?: string;     // $HOME path, must never appear
}

export function hasIpLiteral(text: string): boolean {
  return IPV4.test(text) || IPV6.test(text);
}

// Returns human-readable findings (field paths only, never the matched text). Empty array = clean.
export function scanForLeaks(value: unknown, opts: ScanOptions = {}): string[] {
  const findings: string[] = [];
  const secrets = (opts.secrets ?? []).filter((s) => s.length >= 8);
  const home = opts.homeDir && opts.homeDir.length >= 3 ? opts.homeDir : null;

  const visit = (node: unknown, path: string, key = ''): void => {
    if (typeof node === 'string') {
      if (STRUCTURED_KEYS.has(key)) return;
      if (hasIpLiteral(node)) findings.push(`ip-literal:${path}`);
      if (secrets.some((s) => node.includes(s))) findings.push(`secret:${path}`);
      if (home && node.includes(home)) findings.push(`home-path:${path}`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`, key));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, child] of Object.entries(node)) visit(child, path ? `${path}.${k}` : k, k);
    }
  };
  visit(value, '');
  return findings;
}
