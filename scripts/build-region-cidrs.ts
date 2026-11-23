// Builds collector/data/region-cidrs.json from AWS ip-ranges.json (EC2) and Azure Service Tags (AzureCloud.*).
//   node scripts/build-region-cidrs.ts [--aws <path>] [--azure <path>] [--out <path>] [--azure-source <name>]
// Without --aws / --azure the sources are fetched. Output is deterministic: sorted by provider, cidr, region.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseCidr } from '../collector/src/region.ts';

const AWS_URL = 'https://ip-ranges.amazonaws.com/ip-ranges.json';
const AZURE_PAGE_URL = 'https://www.microsoft.com/en-us/download/details.aspx?id=56519';
const USER_AGENT = 'runner-atlas-region-builder';
const DEFAULT_OUT = fileURLToPath(new URL('../collector/data/region-cidrs.json', import.meta.url));

// Azure Service Tag short names -> canonical ARM region names.
const AZURE_ALIASES: Record<string, string> = {
  centralfrance: 'francecentral',
  southfrance: 'francesouth',
  germanywc: 'germanywestcentral',
  germanyn: 'germanynorth',
  norwaye: 'norwayeast',
  norwayw: 'norwaywest',
  switzerlandn: 'switzerlandnorth',
  switzerlandw: 'switzerlandwest',
  chilec: 'chilecentral',
  brazilse: 'brazilsoutheast',
  brazilne: 'brazilnortheast',
};

export interface RegionCidr { cidr: string; region: string; provider: 'aws' | 'azure'; source: string }

export interface BuildInput {
  aws?: {
    prefixes?: Array<{ ip_prefix?: string; region?: string; service?: string }>;
    ipv6_prefixes?: Array<{ ipv6_prefix?: string; region?: string; service?: string }>;
  };
  azure?: {
    cloud?: string;
    values?: Array<{ name?: string; properties?: { region?: string; addressPrefixes?: string[] } }>;
  };
  azureSource?: string;
}

export function normalizeAzureRegion(region: string): string {
  const r = region.trim().toLowerCase();
  return AZURE_ALIASES[r] ?? r;
}

// Keeps only host-free ranges (drops /32 and /128) and removes duplicate (cidr, region, provider) rows.
export function buildRegionCidrs(input: BuildInput): RegionCidr[] {
  const out = new Map<string, RegionCidr>();
  const add = (cidr: string | undefined, region: string, provider: 'aws' | 'azure', source: string) => {
    if (!cidr || !region || parseCidr(cidr) === null) return;
    const key = `${provider}\u0000${cidr}\u0000${region}`;
    if (!out.has(key)) out.set(key, { cidr, region, provider, source });
  };

  const awsSource = 'aws-ip-ranges-EC2';
  for (const p of input.aws?.prefixes ?? []) {
    if (p.service === 'EC2' && p.region && p.region !== 'GLOBAL') add(p.ip_prefix, p.region.trim().toLowerCase(), 'aws', awsSource);
  }
  for (const p of input.aws?.ipv6_prefixes ?? []) {
    if (p.service === 'EC2' && p.region && p.region !== 'GLOBAL') add(p.ipv6_prefix, p.region.trim().toLowerCase(), 'aws', awsSource);
  }

  const azureSource = input.azureSource ?? 'azure-service-tags';
  for (const v of input.azure?.values ?? []) {
    const region = v.properties?.region ?? '';
    if (!region || !(v.name ?? '').startsWith('AzureCloud.')) continue;
    for (const cidr of v.properties?.addressPrefixes ?? []) add(cidr, normalizeAzureRegion(region), 'azure', azureSource);
  }

  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...out.values()].sort((a, b) => cmp(a.provider, b.provider) || cmp(a.cidr, b.cidr) || cmp(a.region, b.region));
}

// One entry per line, matching the committed file's layout.
export function formatRegionCidrs(entries: RegionCidr[]): string {
  return `[\n${entries.map((e) => JSON.stringify(e)).join(',\n')}\n]\n`;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return res.json();
}

// Finds the current Service Tags JSON link on the Microsoft download page. Throws when none is present.
export function findAzureServiceTagsUrl(html: string): string {
  const m = html.match(/https:\/\/download\.microsoft\.com\/download\/[^"'\s<>]+?\/ServiceTags_Public_\d+\.json/);
  if (!m) throw new Error('no ServiceTags_Public_<n>.json link on the Azure download page');
  return m[0];
}

async function fetchSources(awsPath: string | undefined, azurePath: string | undefined, azureSourceArg: string | undefined) {
  const aws = awsPath ? JSON.parse(readFileSync(awsPath, 'utf8')) : await getJson(AWS_URL);
  let azure: unknown;
  let azureSource = azureSourceArg;
  if (azurePath) {
    azure = JSON.parse(readFileSync(azurePath, 'utf8'));
    azureSource ??= 'azure-service-tags';
  } else {
    const res = await fetch(AZURE_PAGE_URL, { headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`GET ${AZURE_PAGE_URL} failed: HTTP ${res.status}`);
    const url = findAzureServiceTagsUrl(await res.text());
    azure = await getJson(url);
    azureSource ??= `azure-service-tags-${basename(url).replace(/\.json$/, '')}`;
  }
  return { aws, azure, azureSource };
}

async function main() {
  const { values } = parseArgs({
    options: {
      aws: { type: 'string' },
      azure: { type: 'string' },
      out: { type: 'string' },
      'azure-source': { type: 'string' },
    },
    strict: true,
  });
  const { aws, azure, azureSource } = await fetchSources(values.aws, values.azure, values['azure-source']);
  const entries = buildRegionCidrs({
    aws: aws as BuildInput['aws'],
    azure: azure as BuildInput['azure'],
    azureSource,
  });
  if (!entries.some((e) => e.provider === 'aws') || !entries.some((e) => e.provider === 'azure')) {
    throw new Error('refusing to write: one provider has no entries');
  }
  const out = resolve(values.out ?? DEFAULT_OUT);
  writeFileSync(out, formatRegionCidrs(entries));
  console.log(`wrote ${entries.length} entries to ${out}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
