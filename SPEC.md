# Runner Atlas: specification

The single source of truth for every implementation thread. Visual rules live in `DESIGN.md`; the reasons behind choices live in `DECISIONS.md`. If code and this file disagree, this file wins until it is amended in the same PR.

Runner Atlas is a public repo that passively fingerprints GitHub-hosted Actions runners every hour (`17 * * * *`) and publishes a growing static dashboard on GitHub Pages. No LLM runs at runtime. Workflows use only the default `GITHUB_TOKEN`.

## 0. Repository layout

```
.github/workflows/atlas.yml        hourly survey + publish + deploy
.github/workflows/ci.yml           PR / push verification
collector/matrix.json              the runner matrix (single source of truth)
collector/src/*.ts                 zero-dependency collector (Node 22 type stripping)
collector/data/region-cidrs.json   curated CIDR -> region table
collector/fixtures/probe-1mib.bin  network throughput probe payload (1 MiB, incompressible, see 3.6)
.gitattributes                     probe-1mib.bin binary -diff
aggregator/src/*.ts                ingest, validate, dedupe, rollups, stats, field log
aggregator/data/region-coords.json Azure region -> lat/lon
schemas/raw-sample.schema.json     JSON Schema 2020-12, additionalProperties: false
schemas/rollups/*.schema.json      one schema per rollup file
shared/types/sample.ts             RawSample type
shared/types/rollups.ts            rollup types (section 4)
scripts/synthetic/generate.ts      synthetic raw generator (writes outside data/)
scripts/make-probe.ts              writes probe-1mib.bin from mulberry32(fnv1a32("probe"))
scripts/publish.sh                 ingest -> rollup -> commit -> push retry loop
scripts/audit/screenshots.ts       Playwright screenshot harness (M11, section 8)
scripts/assets/                    og-card.html template, plates.ts (M7, DESIGN section 9)
data/raw/.gitkeep                  stays empty until live runs
data/rollups/*.json                ships as valid Day-0 empty rollups
site/                              Vite static site (section 6)
site/assets/                       imported visual assets, hashed by Vite (M7, DESIGN section 9)
site/public/                       assets that need stable unhashed URLs: favicons, og-card.png (M7)
tests/unit/**/*.test.ts            Vitest unit suites
tests/integration/**/*.test.ts     Vitest determinism and synthetic-tier suites
tests/e2e/**/*.spec.ts             Playwright (@playwright/test), never collected by Vitest
vitest.config.ts                   include tests/unit + tests/integration, exclude tests/e2e
playwright.config.ts               Chromium, webServer = vite preview
audit/screenshots/                 committed audit captures from synthetic presets (M11)
audit/hallmark-audit.md            sloplint output, waivers, review outcomes (M11)
README.md  SETUP.md                overview; owner setup (Pages source, dispatch checks, cron gate)
LICENSE  NOTICE                    Apache-2.0 ("Copyright 2026 Aieat Assam") for code; NOTICE credits data sources, fonts and assets
THIRD_PARTY_LICENSES.md            licences of vendored skills (.claude/skills/), bundled fonts, world-atlas, d3, three
```

One root `package.json`, one root `tsconfig.json` (`module: nodenext`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noEmit`, `strict`, `lib: ["ES2023","DOM"]`). Runtime TS runs via Node 22.18+ native type stripping: no enums, no parameter properties, imports carry `.ts`, type-only imports use `import type`. Dev dependencies (Vite, Vitest, Playwright, ajv, d3, three) are installed only where a job runs `npm ci`; the collector never needs them (D-014). `npm test` = `vitest run`.

## 1. Architecture and data flow

```
schedule 17 * * * * / workflow_dispatch
  -> plan            reads collector/matrix.json, drops vars.RUNNER_ATLAS_DISABLED_LABELS
  -> collect x N     one job per (label, replica); emits sample.json (~1.2 KB) as artifact sample-<label>-r<replica>
  -> publish         download sample-* to .tmp/incoming -> validate (schema + privacy scan) -> dedupe by id
                     -> append data/raw/YYYY/MM/DD.jsonl -> rebuild data/rollups/ (full rebuild)
                     -> commit + push main (retry loop) -> vite build (base './') to site/dist
                     -> upload-pages-artifact (path site/dist)
  -> deploy          actions/deploy-pages
```

- **Raw partition**: UTC date of `collectedAtIso`. One sample per line, compact JSON, lines sorted by `id` within a file.
- **Dedupe key**: `id = "<runId>.<runAttempt>.<label>.<replica>"`. Re-ingesting is idempotent.
- **Rollups are a pure function of `data/raw/`**: no wall clock, no `Math.random`. Every PRNG is `mulberry32(fnv1a32(key))` with a documented key. Floats are rounded at fixed decimals (seconds 1, scores 2, MB/s 1, GB/s 2, percentages 2, correlations 3, densities 3). Output is compact JSON plus `\n`, keys in declared order. Rebuilding twice yields byte-identical files (tested).
- **Quarantine**: a sample failing schema, privacy scan or the 2048-byte hard limit is dropped and listed in `$GITHUB_STEP_SUMMARY`. It is never committed.
- **Clean-repo rule**: `data/raw/` holds only `.gitkeep` until live runs commit. `data/rollups/` ships the Day-0 output of `rollup` over an empty raw dir (a test rebuilds it and diffs). Synthetic data never enters `data/`: `scripts/synthetic/generate.ts --days <0|1|3|7|14|30|90> --seed 7 --start 2026-01-05 --out .tmp/synthetic/day-<d>` writes `<out>/raw/...` and runs the aggregator into `<out>/rollups/`. `.tmp/` is gitignored. Synthetic samples carry `src: "synthetic"`, and the manifest then reports `dataSource: "synthetic"`; the site shows a persistent "Synthetic sample data, not measurements" notice.
- **Site data**: an inline Vite plugin in `site/vite.config.ts` copies `${RUNNER_ATLAS_ROLLUPS_DIR:-data/rollups}` to `dist/data/rollups/` at `closeBundle`, and prerenders static HTML from `manifest.json` in `transformIndexHtml` (section 6.6).

## 2. Runner matrix, concurrency and cron gate

`collector/matrix.json`:

| label | replicas | optional | os |
| --- | --- | --- | --- |
| `ubuntu-24.04` | 3 | false | linux x64 |
| `ubuntu-24.04-arm` | 2 | false | linux arm64 |
| `windows-2025` | 2 | false | windows x64 |
| `windows-11-arm` | 1 | true | windows arm64 |
| `macos-15` | 2 | false | macos arm64 |
| `macos-15-intel` | 1 | true | macos x64 |

11 collector jobs, 3 macOS. Free public-repo limits are 20 concurrent jobs and 5 concurrent macOS jobs; peak use is 11 collectors plus plan/publish/deploy (never simultaneous with collectors), 3 macOS.

Workflow contract (`atlas.yml`):

- `on: schedule: [{cron: '17 * * * *'}]` and `workflow_dispatch`. Top-level `permissions: {}`.
- `plan` job: `if: github.event_name != 'schedule' || vars.RUNNER_ATLAS_CRON_ENABLED == 'true'`. Everything else `needs: plan`, so a gated-off schedule run does nothing. The owner verifies `workflow_dispatch` on every OS per `SETUP.md`, then sets the variable. Output `matrix` built with `jq` from `collector/matrix.json`, minus labels in `vars.RUNNER_ATLAS_DISABLED_LABELS` (comma list; the escape hatch for a retired label that would otherwise sit queued up to 24 h). Permissions `contents: read`.
- `collect`: `name: collect ${{ matrix.label }} r${{ matrix.replica }}` (the collector looks itself up by this exact name), `runs-on: ${{ matrix.label }}`, `strategy: {fail-fast: false, matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}}`, `continue-on-error: ${{ matrix.optional }}`, `timeout-minutes: 6`, permissions `contents: read, actions: read`. Steps: `actions/checkout` with `persist-credentials: false` and `sparse-checkout` of `package.json` (its `"type": "module"` tells Node how to run the `.ts` files), `collector/src`, `collector/data`, `collector/matrix.json`, `shared/types` (cone mode off; `collector/fixtures/` is not checked out, the probe is fetched over HTTP), `setup-node` `22` (no `npm ci`, no cache), `node collector/src/collect.ts --label ... --replica ... --out sample.json` with `GITHUB_TOKEN: ${{ github.token }}`, `upload-artifact` (`retention-days: 3`, `if-no-files-found: error`). The in-job self-check is structural and dependency-free (`collector/src/selfcheck.ts`: exact key set, types, <= 1600 bytes, `benchmarkDurationMs <= 20000`, no IP-like string); full JSON Schema validation with `ajv` happens in `publish`.
- `publish`: `needs: [plan, collect]`, `if: ${{ !cancelled() && needs.plan.result == 'success' }}`, `concurrency: {group: runner-atlas-publish, cancel-in-progress: false}`, permissions `contents: write`, `timeout-minutes: 10`, `runs-on: ubuntu-24.04`. Steps: `actions/checkout` with **`persist-credentials: true`** (stated explicitly; `scripts/publish.sh` pushes with the checkout's `GITHUB_TOKEN` credentials) and `fetch-depth: 1`; `setup-node` `22` with `cache: npm`; `npm ci`; `actions/download-artifact` with `pattern: sample-*`, `path: .tmp/incoming`, `merge-multiple: false`, `continue-on-error: true` (zero matching artifacts leaves `.tmp/incoming` empty and the run carries on); `scripts/publish.sh`; `npm run build` with `RUNNER_ATLAS_SITE_URL` set (below); `actions/upload-pages-artifact` with `path: site/dist`. Aggregation never fails because a collector failed or was absent: missing labels are simply absent samples. When no sample validates, nothing is committed and the site is still rebuilt and deployed.
- `deploy`: `needs: publish`, permissions `pages: write, id-token: write`, `environment: {name: github-pages, url: ${{ steps.deployment.outputs.page_url }}}`, one step `actions/deploy-pages` (`id: deployment`). `actions/configure-pages` is not used: `SETUP.md` sets Settings > Pages > Source to "GitHub Actions" once, and `base: './'` needs no base path.
- Site URL: `RUNNER_ATLAS_SITE_URL = vars.RUNNER_ATLAS_SITE_URL || https://<owner>.github.io/<repo>/` (owner and repo from `GITHUB_REPOSITORY`). Only `og:image`/`og:url` use it; locally it defaults to `http://localhost:4173/`.
- Concurrency semantics: `cancel-in-progress: false` never cancels a running publish, but GitHub keeps only one pending job per group, so a third overlapping run replaces the older pending one and that run's samples are lost. Accepted (only happens under dispatch spam).
- Push loop (`scripts/publish.sh`): up to 3 attempts of `git fetch origin main && git reset --hard origin/main`, re-ingest from `.tmp/incoming`, rebuild rollups, commit as `github-actions[bot]` with message `data: sweep <slotIso> (<k> samples)`, `git push`. Ingest is idempotent, so a rebuild on the newer main is always correct. Commits pushed with `GITHUB_TOKEN` do not retrigger workflows. Bot commits count as repo activity, so the 60-day schedule auto-disable does not trip.
- **Every `uses:` is pinned to a 40-char commit SHA** with the tag in a trailing comment: `uses: actions/checkout@<sha> # v4.x.y`. Resolve with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`; never hand-type a SHA. Actions used (exhaustive): `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact`, `actions/upload-pages-artifact`, `actions/deploy-pages`. CI greps `uses:` lines for `@[0-9a-f]{40}` and runs `actionlint`.

## 3. Collector specification and guardrails

### 3.1 Hard guardrails

- Passive only. No port scan, no probing of other hosts or internal ranges, no attempt to see past the VM boundary. The only network calls are listed in 3.4 and 3.6.
- Never stored or logged: environment variables beyond the allowlist, tokens, hostnames (`os.hostname()` is never called), usernames, paths under `$HOME`, MAC addresses, full IP addresses.
- Env allowlist: `ImageOS`, `ImageVersion`, `RUNNER_OS`, `RUNNER_ARCH`, `RUNNER_ENVIRONMENT`.
- The egress IP exists only in a local variable of `region.ts`, is never passed to `console.*`, never serialized, and is dropped after matching.
- The validator rejects any string matching a bare IPv4/IPv6 address, any `/32` or `/128`, and any field not in the schema.
- Every subprocess runs with a 3000 ms timeout and fixed argv (no shell interpolation).

### 3.2 Raw sample (`shared/types/sample.ts`, schema `runner-atlas/raw-sample@1`)

```ts
export type RunnerLabel = 'ubuntu-24.04' | 'ubuntu-24.04-arm' | 'windows-2025' | 'windows-11-arm' | 'macos-15' | 'macos-15-intel';
export type DiskKind = 'nvme' | 'ssd' | 'hdd' | 'virtual' | 'unknown';
export interface RawSample {
  v: 1;
  id: string;                         // "<runId>.<runAttempt>.<label>.<replica>"; local: "local.<epochMs>.<label>.1"
  src: 'live' | 'local' | 'synthetic';
  label: RunnerLabel; replica: number;
  event: 'schedule' | 'workflow_dispatch' | 'local';
  collectedAtIso: string;
  timing: {
    scheduledSlotIso: string | null; runCreatedAtIso: string | null;
    jobQueuedAtIso: string | null; jobStartedAtIso: string | null;
    cronDriftSec: number | null; queueTimeSec: number | null; totalDelaySec: number | null;
  };
  env: { imageOS: string | null; imageVersion: string | null; runnerOS: string | null; runnerArch: string | null; runnerEnvironment: string | null; agentVersion: string | null };
  os: { name: string; version: string; kernel: string };
  cpu: { model: string; vendor: string; logical: number; physical: number | null; flags: string[] };   // flags <= 12
  memGB: number;
  disk: { totalGB: number; freeGB: number; kind: DiskKind; fs: string | null };
  place: { imdsStatus: 'reachable' | 'unreachable'; region: string | null; vmSize: string | null; inferredRegion: string | null; matchedCidr: string | null; method: 'imds' | 'cidr' | 'none' };
  uptimeSec: number;
  stealPct: number | null;            // Linux only
  bench: {
    benchmarkDurationMs: number;      // <= 20000, schema maximum
    singleCoreScore: number | null; multiCoreScore: number | null;   // Mops/s of the kernel; null only when the step is in `truncated`
    seqWriteMBs: number | null; seqReadMBs: number | null;
    memBandwidthGBs: number | null;
    netTtfbMs: number | null; netMbps: number | null;
    netProbe: 'repo' | 'meta' | null; // which body netMbps was timed on (3.6); null when netMbps is null
    truncated: Array<'single' | 'multi' | 'disk' | 'mem' | 'net'>;
  };
}
```

Serialized size target <= 1600 bytes (collector test), hard reject > 2048 (validator).

### 3.3 Hardware, OS, agent

- CPU model: Linux `/proc/cpuinfo` `model name`, else `lscpu` `Model name` (ARM); macOS `sysctl -n machdep.cpu.brand_string`; Windows `os.cpus()[0].model`. Vendor from `vendor_id`, ARM `CPU implementer` (0x41 Arm, 0xc0 Ampere), or brand prefix. `logical = os.availableParallelism()`; `physical` from `lscpu`/`sysctl hw.physicalcpu`/null.
- Flags: intersection of the CPU's flags with the allowlist `avx avx2 avx512f avx512bw avx512vnni amx_tile fma bmi2 aes sha_ni sse4_2 asimd sve sve2 lse` (macOS `hw.optional.*`), sorted, max 12. Windows: `[]`.
- Memory: `os.totalmem()/2^30`, 1 decimal. Disk: `fs.statfsSync(os.tmpdir())`. Kind: Linux `/sys/block/<dev>/queue/rotational` plus `nvme` device name, `virtual` when the model string names a hypervisor disk (`Virtual Disk`, `Msft`); macOS `diskutil info /` "Solid State"; Windows `Get-PhysicalDisk` MediaType/BusType. fs: `findmnt -no FSTYPE`, `diskutil` "Type (Bundle)", Windows `Get-Volume`.
- OS: Linux `/etc/os-release` `PRETTY_NAME`; macOS `sw_vers -productVersion`; Windows `os.version()`. Kernel `os.release()`.
- Agent version: best effort, each attempt <= 1000 ms: a semver-named directory under `$HOME/runners/` (Linux/macOS hosted images), else `Runner.Listener --version` beside `RUNNER_TEMP`'s runner root; else `null`. The SETUP dispatch run reports the null rate.

### 3.4 Region and VM size

1. One `GET http://169.254.169.254/metadata/instance?api-version=2021-02-01`, header `Metadata: true`, `AbortSignal.timeout(2000)`. On 200: keep only `compute.location` and `compute.vmSize`, `imdsStatus: "reachable"`, `method: "imds"`. Anything else: `"unreachable"`.
2. Only when unreachable: obtain the egress IP in memory from `https://1.1.1.1/cdn-cgi/trace` (parse the `ip=` line only, 2000 ms timeout; see D-011). Fetch `https://api.github.com/meta` (auth with token), and match against `actions` ranges plus `collector/data/region-cidrs.json` (`{cidr, region, provider, source}`, curated from Azure service tags, AWS `ip-ranges.json` and `/meta`). `/meta` ranges are not region-tagged: `inferredRegion` comes only from the curated table; `matchedCidr` is the most specific matching range exactly as published (never narrower than the published prefix). `method: "cidr"`, or `"none"` with both null.

### 3.5 Uptime and CPU steal

`uptimeSec = round(os.uptime())` at collector start. Linux: read `/proc/stat` `cpu` line before and after the benchmark block; `stealPct = 100 * Δsteal / Δ(user+nice+system+idle+iowait+irq+softirq+steal)`, 2 decimals. Windows and macOS: `null` (hypervisor steal is not exposed to userland).

### 3.6 Micro-benchmarks (hard budget 20 000 ms)

A `Deadline` object starts before step 1: `deadline = t0 + 20000`. Each step gets `budget = min(cap, deadline - now - 250)`; a step whose budget < 200 ms is skipped and named in `truncated`. Inner loops check `performance.now()` at <= 50 ms granularity; network calls use `AbortSignal.timeout(budget)`; workers are `terminate()`d at their budget. `benchmarkDurationMs = round(now - t0)` and the collector throws (no sample) rather than emit > 20000. Target total job time < 2 min.

| step | cap ms | method | result |
| --- | --- | --- | --- |
| single | 2500 | deterministic kernel (xorshift32 + integer mix + one fused multiply-add per iteration) in batches of 2^16, run until 2300 ms | `singleCoreScore` = Mops/s |
| multi | 3500 | same kernel in `worker_threads` x `logical`, 3000 ms window after all report ready | `multiCoreScore` = summed Mops/s |
| disk | 6000 | 4 MiB chunks to `os.tmpdir()/atlas-<pid>.bin`, stop at 128 MiB or 40% of budget, `fsync`; read back the same bytes; `unlink` in `finally` | `seqWriteMBs` (incl. fsync), `seqReadMBs` (page-cache influenced; Methods says so) |
| mem | 2500 | 64 MiB `Float64Array.set()` copies plus a sum reduction until 2300 ms | `memBandwidthGBs` (bytes read + written / s) |
| net | 4500 | 5 sequential `GET https://api.github.com/zen` (token auth when a token is present), time to response headers, median; then one throughput GET (below), Mbps = body bytes x 8 / (last byte - response headers) | `netTtfbMs`, `netMbps`, `netProbe` |

Throughput probe, in order:

1. `repo`: when `GITHUB_REPOSITORY` and `GITHUB_SHA` are both set, `GET https://raw.githubusercontent.com/<GITHUB_REPOSITORY>/<GITHUB_SHA>/collector/fixtures/probe-1mib.bin`. Accepted only on HTTP 200 with exactly 1,048,576 body bytes.
2. `meta`: otherwise (`--local`, a fork before its first push, a private fork, or step 1 answering non-200 or the wrong length), one `GET https://api.github.com/meta`, GitHub-owned like every other collector endpoint. Its size varies with GitHub's published ranges, so the result is recorded as `netProbe: "meta"` and is never pooled with `repo` results.
3. Both fail or the budget runs out: `netMbps: null`, `netProbe: null`, `net` in `truncated` only when the budget was the cause.

Both requests send `accept-encoding: identity`. Whatever the header does, the guard is on the response: a probe response carrying any `content-encoding` header is treated as failed and the next probe is tried, so the counted bytes are always the bytes on the wire. The aggregator uses only `netProbe === "repo"` samples for `netMbps` statistics; `meta` samples keep `netTtfbMs`. Live runs always have both variables and a pushed public SHA, so `meta` appears in practice only in `--local` runs (the synthetic generator always writes `repo`).

`probe-1mib.bin` is exactly 1 MiB of `mulberry32(fnv1a32("probe"))` output, so gzip cannot shrink it and a rebuild reproduces it byte for byte; a unit test pins its SHA-256. It is marked `binary -diff` in `.gitattributes`, costs one MiB per full clone once (it never changes), and is excluded from the collect job's sparse checkout. `netMbps` is timed from response headers to last byte, so connection setup is excluded, but on a fast runner a 1 MiB body finishes within a few round trips and the figure is bounded by TCP slow start and RTT to GitHub's CDN, not by link capacity. It is a comparable cross-runner index of short-transfer throughput, not bandwidth; Methods says so. The size is fixed so the index stays comparable over time.

### 3.7 Timing

Collector calls `GET /repos/{repo}/actions/runs/{run_id}` and `.../runs/{run_id}/attempts/{attempt}/jobs`, finds its job by name. `--local` mode skips both and sets every timing field to `null`.

- `scheduledSlotIso` (schedule events only): the latest `HH:17:00Z` at or before `runCreatedAtIso`. Dispatch runs: `null`.
- `cronDriftSec = runCreatedAt - scheduledSlot` (>= 0). `queueTimeSec = jobStartedAt - jobQueuedAt` (job `created_at` -> `started_at`). `totalDelaySec = jobStartedAt - scheduledSlot` (= drift + job-creation latency + queue).

## 4. Aggregation, rollup contracts, statistics

### 4.1 Common definitions

- `surveyDay = samples == 0 ? 0 : (utcDate(last collectedAtIso) - utcDate(first collectedAtIso)) in whole days + 1`. Calendar UTC dates, not elapsed milliseconds, so `surveyDay`, `opensOn` and the daily field log agree: the first sample's date is day 1 whatever its hour. With full coverage the survey gathers about 264 samples a day (11 jobs x 24 sweeps), 216 with both optional labels disabled.
- `slotsExpected` = hourly :17 slots from the first to the last observed scheduled slot inclusive; `slotsObserved` = distinct slots with >= 1 schedule-event sample; `coverage = observed / expected`.
- Weekday `0 = Monday ... 6 = Sunday` (ISO weekday - 1), UTC, of the scheduled slot.
- Nulls: every statistic skips null values, and its `n` counts the non-null values it used (benchmark fields are null when their step was truncated, timing fields on dispatch and local runs, `stealPct` off Linux).
- Quantiles: type 7 (linear interpolation). MAD scaled by 1.4826. Bootstrap: percentile interval, B = 1000, PRNG key per statistic (e.g. `drift:<weekday>:<hour>`).
- **The run is the unit for delay.** All jobs of one run share one slot and one `runCreatedAt`, so drift/delay statistics resample runs, not samples. Run delay `D_r = median(totalDelaySec over the run's jobs)`. Cell `n` reported in runs (with samples alongside).
- `cpuFamily`: normalized model (`aggregator/src/hardware.ts` regex table: strip `(R)`, `(TM)`, `CPU @ x GHz`, core counts; e.g. `AMD EPYC 7763`, `Intel Xeon Platinum 8370C`, `Apple M1 (Virtual)`, `Neoverse-N2`), unknown -> `"unknown"`.
- Region key: `place.region ?? place.inferredRegion ?? "unknown"`.
- Subsamples: select the K samples with the lowest `fnv1a32(id)` per stratum. Stable as data grows.
- Every rollup starts with `schema`, `range: {from, to} | null` (`YYYY-MM-DD`), `n: {samples, runs}`. `schema` is `"runner-atlas/<name>@1"` (`manifest` included), matching each schema file's `title`.
- Schema files use JSON Schema 2020-12 `pattern` for dates and timestamps, never `format`, so they compile under plain `ajv/dist/2020` strict mode without `ajv-formats`. Known ceiling: calendar-impossible dates such as `2026-02-30` pass the regex. Cross-field rules JSON Schema cannot express (equal column lengths in `points`, `daily` arrays aligned to `days`, drift cell order, `id` label equal to `label`) are aggregator tests.

### 4.2 Files under `data/rollups/` (`shared/types/rollups.ts`)

```ts
export type RollupName = 'fleet' | 'benchmarks' | 'drift' | 'neighbours' | 'rollouts' | 'seasonality' | 'regions';
export type TierId = 'day1' | 'day3' | 'day7' | 'day14' | 'day30' | 'day90';
export type ConfidenceTier = 'insufficient' | 'preliminary' | 'emerging' | 'established' | 'high';
export type MetricId = 'singleCoreScore' | 'multiCoreScore' | 'seqWriteMBs' | 'seqReadMBs' | 'memBandwidthGBs' | 'netTtfbMs' | 'netMbps';
export interface DateRange { from: string; to: string }
export interface Head { schema: string; range: DateRange | null; n: { samples: number; runs: number } }
export interface Q4 { median: number; p25: number; p75: number; p95: number }
export interface Q5 { p10: number; p25: number; p50: number; p75: number; p90: number }
export interface SlotScore { weekday: number | null; hourUtc: number; runs: number; samples: number; medianSec: number; p90Sec: number; score: number; ci95: [number, number] }

export interface Manifest extends Head {            // manifest.json
  dataSource: 'empty' | 'live' | 'synthetic';
  firstSampleIso: string | null; lastSampleIso: string | null;
  surveyDay: number; labelsActive: RunnerLabel[];
  slotsExpected: number; slotsObserved: number; coverage: number | null;
  tiers: Array<{ id: TierId; minDays: number; minSamples: number; status: 'open' | 'charting'; samplesNeeded: number; daysNeeded: number; opensOn: string | null }>;
  headline: { tier: ConfidenceTier; granularity: 'hour' | 'weekday-hour' | null; best: SlotScore | null; worst: SlotScore | null; separated: boolean | null; reason: string | null };
  fieldLog: Array<{ date: string; partial: boolean; text: string }>;   // newest first
  files: Array<{ name: RollupName; path: string; bytes: number; sha256: string }>;
}
export interface FleetRollup extends Head {          // fleet.json
  labels: Array<{ label: RunnerLabel; os: string; arch: string; samples: number; runs: number; cpuFamilies: Array<{ family: string; n: number }>; memGB: Q5 | null; diskKinds: Partial<Record<DiskKind, number>>; imageVersion: string | null; agentVersion: string | null }>;
  breakdown: { osVersions: Array<{ key: string; n: number }>; imageVersions: Array<{ key: string; n: number }>; regions: Array<{ key: string; n: number }> };
  sankey: { nodes: Array<{ id: string; kind: 'label' | 'hardware' | 'region'; name: string }>; links: Array<{ source: string; target: string; value: number }> };  // label -> cpuFamily -> region
  recentSamples: Array<{ id: string; collectedAtIso: string; label: RunnerLabel; cpuFamily: string; region: string; singleCoreScore: number | null; totalDelaySec: number | null }>;  // latest 20
}
export interface GroupSummary { key: string; label: RunnerLabel | null; cpuFamily: string | null; n: number; q: Q5; mad: number; kde: number[]; hist: number[] }
// key: "<label>" in byLabel, "<label>|<cpuFamily>" in byHardware. kde: 64 values on the metric grid, [] when n < 5. hist: 32 counts over domain, always present. Groups with n == 0 are omitted.
export interface BenchmarksRollup extends Head {     // benchmarks.json
  metrics: Array<{ id: MetricId; unit: string; better: 'higher' | 'lower'; n: number; domain: [number, number] | null; grid: number[] }>;  // always all 7, in MetricId order; grid: 64 x values over domain, [] and domain null when n == 0
  byLabel: Record<MetricId, GroupSummary[]>; byHardware: Record<MetricId, GroupSummary[]>;   // every MetricId key always present, [] when empty
  points: { labels: string[]; families: string[]; id: string[]; label: number[]; family: number[]; single: number[]; write: number[]; mem: number[]; multi: number[]; date: string[] };
  // column arrays of equal length; only samples where single, write, mem and multi are all non-null; <= 2000 by lowest fnv1a32(id), stratified by label
  beeswarm: number[];                                // indices into points, <= 120 per label (lowest fnv1a32(id)); beeswarm draws single, multi, write, mem only
}
export interface DriftCell { weekday: number | null; hourUtc: number; runs: number; samples: number; drift: Q4 | null; queue: Q4 | null; total: Q4 | null; score: number | null; ci95: [number, number] | null }
// DriftCell: drift/queue/total null when runs == 0; score/ci95 null when runs < 3 (4.3).
export interface DriftRollup extends Head {          // drift.json (schedule events only)
  weekdayHour: DriftCell[];                          // always 168, index = weekday * 24 + hourUtc
  byHour: DriftCell[];                               // always 24, weekday null
  byLabel: Array<{ label: RunnerLabel; byHour: Array<{ hourUtc: number; runs: number; queue: Q4 | null }> }>;
  ranking: { granularity: 'hour' | 'weekday-hour' | null; best: SlotScore[]; worst: SlotScore[] };   // top 5 each
  slots: { expected: number; observed: number; missedByHour: number[] };
  terrain: { min: number | null; max: number | null; contours: number[] };
  // min/max of weekdayHour total.median over cells with runs > 0 (seconds); contours = d3-array ticks(min, max, 6) strictly inside (min, max); [] when fewer than 2 such cells or min == max
}
export interface NeighboursRollup extends Head {     // neighbours.json (Linux only)
  overall: { n: number; spearmanRho: number | null; rhoCi95: [number, number] | null; rhoAbs: number | null; pearsonR: number | null; slope: number | null; intercept: number | null };
  buckets: Array<{ lo: number; hi: number | null; n: number; zMedian: number; zP25: number; zP75: number; absZMedian: number }>;  // steal % [0,.5) [.5,1) [1,2) [2,5) [5,inf)
  points: { labels: string[]; families: string[]; steal: number[]; z: number[]; label: number[]; family: number[] };   // <= 1500
  byHardware: Array<{ label: RunnerLabel; cpuFamily: string; n: number; stealMedian: number; stealP90: number; rho: number | null; slope: number | null }>;
}
export interface RolloutsRollup extends Head {       // rollouts.json
  days: string[];
  byLabel: Array<{ label: RunnerLabel; images: Array<{ version: string; firstSeen: string; lastSeen: string; share: Array<number | null> }>; families: Array<{ family: string; share: Array<number | null> }>; events: Array<{ date: string; from: string; to: string }> }>;
  // days: every UTC date from range.from to range.to inclusive, gap days included. share arrays align to days; null on a day the label has no samples.
  // images and families: top 7 by samples per label, the rest pooled as version/family "other".
  changePoints: Array<{ label: RunnerLabel; metric: MetricId | 'totalDelaySec'; date: string; before: { median: number; n: number }; after: { median: number; n: number }; shiftPct: number; u: number; pRaw: number; pAdj: number; nearImageEvent: boolean }>;
  method: { test: 'mann-whitney-u'; alpha: 0.05; minSegmentDays: 3; minSegmentSamples: 30; minShiftPct: 3; maxPerSeries: 3 };
}
export interface SeasonalityRollup extends Head {    // seasonality.json
  days: string[];
  daily: Record<MetricId | 'totalDelaySec', { n: number[]; p10: Array<number | null>; p50: Array<number | null>; p90: Array<number | null>; roll7: { p10: Array<number | null>; p50: Array<number | null>; p90: Array<number | null> } }>;
  // all arrays align to days (every UTC date in range, gaps included); a day's quantiles are null when its n < 20
  weekdayEffect: Record<'totalDelaySec' | 'singleCoreScore', Array<{ weekday: number; n: number; effect: number | null; ci95: [number, number] | null }>>;   // always 7 rows
  diurnalEffect: Record<'totalDelaySec' | 'singleCoreScore', Array<{ hourUtc: number; n: number; effect: number | null; ci95: [number, number] | null }>>;  // always 24 rows
  // effect/ci95 null when that row's n (runs for totalDelaySec, samples for singleCoreScore) < 3
  acf: { dailyTotalDelay: Array<number | null>; hourlyTotalDelay: Array<number | null> };   // always 14 and 168 entries (lags 1..14, 1..168); null when fewer than 10 pairs
  trend: Record<MetricId | 'totalDelaySec', { theilSenPerWeek: number | null; ci95: [number, number] | null }>;   // null with fewer than 14 non-null daily medians
}
export interface RegionsRollup extends Head {        // regions.json
  regions: Array<{ region: string; method: 'imds' | 'cidr' | 'mixed'; lat: number; lon: number; samples: number; share: number; labels: Partial<Record<RunnerLabel, number>>; ttfbMedianMs: number | null; totalDelayMedianSec: number | null; cpuFamilies: Array<{ family: string; n: number }> }>;
  unknown: { samples: number };
}
```

Day-0: every file is `Head` with `range: null`, `n: {samples: 0, runs: 0}`, empty arrays, every `Record` with all its declared keys present and empty values (`[]`, or nulls for `trend`; `daily` arrays `[]`), `benchmarks.metrics` with all 7 entries at `n: 0, domain: null, grid: []`, 168/24 drift cells with `runs: 0` and null stats, 7/24 effect rows and 14/168 ACF entries all null; manifest `dataSource: "empty"`, `surveyDay: 0`, all tiers `charting`, headline `insufficient` with reason `"no samples yet"`.

### 4.3 Headline best and worst scheduling slot

- Cell score: `S = median_r(D_r) + 0.5 * (p90_r(D_r) - median_r(D_r))` over the runs in the cell.
- CI: cluster bootstrap over runs (B = 1000), 2.5th and 97.5th percentiles of S.
- Eligibility: a cell needs >= 3 runs. Granularity `weekday-hour` when >= 70% of the 168 cells are eligible (about day 21), otherwise `hour` (24 cells pooled across weekdays), otherwise `null`.
- Best = min S, worst = max S among eligible cells. Ties: lower p90, then earlier hour. `separated = best.ci95[1] < worst.ci95[0]`.
- Tier: `insufficient` if surveyDay < 3, samples < 150 or no eligible cell (best/worst null); else `preliminary` (< 7 days), `emerging` (7 to 29), `established` (30 to 89), `high` (>= 90 and coverage >= 0.8). If not separated, drop one tier (floor `preliminary`).

### 4.4 Benchmarks

Per metric: `domain = [p1, p99]` of all non-null values (`netMbps`: `netProbe === "repo"` only); when `p1 == p99` the domain widens to `[p1 - max(0.5, 1% of |p1|), p99 + same]`. `grid` = 64 evenly spaced points. Per group (label; label x cpuFamily): Q5, MAD, Gaussian KDE with Silverman `h = 0.9 * min(sd, IQR/1.34) * n^(-1/5)`; when that `min` is 0 use `sd`, and when `h` is still 0 use `(domain[1] - domain[0]) / 64`. Evaluated on the grid and scaled to peak 1; 32-bin histogram over the domain, values outside it clamped into the end bins. Groups with n < 5 keep quantiles and `hist`, empty `kde`. 3D point-cloud outliers (|z| > 3) are computed in the browser from each point's `byHardware.singleCoreScore` group (`q.p50`, `mad`; skipped when `mad == 0`).

### 4.5 Neighbours (Linux, `stealPct != null`)

Per sample `z = (singleCoreScore - median_g) / MAD_g` within group g = label x cpuFamily (groups n >= 20). Spearman rho(steal, z) (expected negative), rhoAbs = rho(steal, |z|), Pearson r, OLS slope of z on steal. rho CI: bootstrap over runs. Buckets and byHardware as typed.

### 4.6 Rollouts and change points

Image events: per label, the first day a new `imageVersion` holds >= 20% daily share. Change points per series (label x {singleCoreScore, multiCoreScore, seqWriteMBs, memBandwidthGBs, totalDelaySec}): samples ordered by time; candidate splits at UTC day boundaries leaving >= 3 days and >= 30 samples each side; two-sided Mann-Whitney U with tie correction (normal approximation); take the min-p split; `p * candidates` (Bonferroni within series); recurse binary segmentation, max 3 per series; then Benjamini-Hochberg at q = 0.05 across all series. Keep where `pAdj < 0.05` and `|median shift| >= 3%`. `nearImageEvent` when an image event is within 1 day.

### 4.7 Seasonality

Daily p10/p50/p90 per metric (null on days with < 20 samples), 7-day centred rolling quantiles over the pooled samples of the 7 days (null within 3 days of either end, or when the window holds < 20 samples). The hour and weekday are those of `scheduledSlotIso` for `totalDelaySec` (schedule events only) and of `collectedAtIso` for benchmark metrics. Weekday and diurnal effects: two-way median polish (2 iterations) on the hour x weekday medians, empty cells skipped, CI by run bootstrap. ACF on the daily median series (lags 1..14) and hourly series (1..168, missing hours skipped pairwise). Theil-Sen slope on daily medians per week, CI by bootstrap over days.

### 4.8 Field log (deterministic templates, zero LLM)

One entry per UTC date with samples, the current date `partial: true`. Sentences, in order, each only when its rule fires:

1. Always: `"{n} samples from {k} runner labels in {r} regions."`
2. >= 3 scheduled runs: `"The longest wait came at {HH}:17 UTC, a median of {dur} before jobs started."`
3. Missed slots > 0: `"{m} of {e} hourly sweeps did not arrive."`, where `e` counts that date's expected slots inside the survey window (fewer than 24 on the first and the current date).
4. A Linux label's daily p95 steal > 2% or > its trailing 14-day p90: `"Linux steal reached {x}% on {label}."`
5. Image event that day: `"{label} moved to image {version}."`
6. Change point dated that day: `"{metric} on {label} shifted {±p}% from the previous segment."`, where `{metric}` is the series' display name ("Single core score", "Total start delay"), never its key (D-024).

Durations format as `41 s`, `3 min 10 s`. Copy never uses dashes, the word "unlock" or buzzwords (DESIGN.md copy rules).

## 5. Progressive tiers

| tier | rule | panels |
| --- | --- | --- |
| Day 0 | samples == 0 | "Awaiting first sweep" standby: graticule map, next sweep time, Methods |
| day1 | days >= 1 && samples >= 5 | `fleet-sankey`, `fleet-table`, `recent-samples`, `globe` (preview), `region-map` |
| day3 | days >= 3 && samples >= 120 | `ridgelines`, `beeswarm`, `pointcloud` |
| day7 | days >= 7 && samples >= 500 | `drift-heatmap`, `terrain`, `slot-ranking`; headline reaches `emerging` |
| day14 | days >= 14 && samples >= 1200 | `neighbours-scatter`, `neighbours-multiples` |
| day30 | days >= 30 && samples >= 3000 | `rollout-timeline`, `changepoints` |
| day90 | days >= 90 && samples >= 9000 | `seasonality-bands`, `seasonality-effects` |

`days` is `surveyDay` (calendar UTC dates, 4.1). `samplesNeeded = max(0, minSamples - samples)`, `daysNeeded = max(0, minDays - surveyDay)`, `opensOn = firstSampleDate + (minDays - 1)` days when only days are short, else `null` (no forecast of sample counts). Thresholds against the ~264 samples a day of full coverage (216 with optional labels off): day3 needs 120 of ~792, day7 500 of ~1,848, day14 1,200 of ~3,696, day30 3,000 of ~7,920, day90 9,000 of ~23,760, so each tier opens on its day at 40% coverage or better; below that, samples gate it. Day 0 is the only tier without a `TierId`: it is the state `samples == 0`, shown instead of every sheet. The "next sweep" time is computed in the browser from the clock (the next `HH:17Z`); the prerendered no-JS text says "Sweeps run hourly at 17 minutes past the hour, UTC." A charting panel renders "Charting in progress" with, in type: `"{samplesNeeded} more samples and {daysNeeded} more days needed."` (omit a zero clause), the expected date, and two native `<progress>` elements (samples, days). Never a row of tick marks.

## 6. Dashboard

### 6.1 Stack

Node 22+, TypeScript, Vite (`base: './'`, `build.manifest: true`), vanilla DOM (no UI framework), D3 modules (`d3-selection`, `d3-scale`, `d3-shape`, `d3-array`, `d3-axis`, `d3-geo`, `d3-contour`, `d3-interpolate`, `d3-sankey`), `world-atlas` (`land-110m.json`) + `topojson-client` bundled, Three.js only through dynamic `import()`. Fonts self-hosted via Fontsource (DESIGN.md). Zero runtime requests outside the site origin.

### 6.2 Information architecture

- `#` (default): title strip, hero, survey sheets, field log, colophon. `#methods`: Methods and caveats. Any other hash scrolls to that id on the dashboard. The nav toggles routes; both are static HTML sections, so no-JS shows both.
- Hero (fits 1280 x 800): headline, one sentence, the headline answer (best and worst slot, median and CI, confidence tier in words), primary action "Browse the survey" (`#survey`), text link "Methods and caveats"; beside it the title block `<dl>` (survey day, samples, date range, last sweep) above the region map sheet (`region-map`, 2D).
- Sheets in tier order: Fleet, Benchmarks, Drift, Neighbours, Rollouts, Seasonality; then Field log.
- **Every chart shows `n` and the date range** in a caption the shell renders from `caption()`: two separate lines, `n = 3,141 samples (412 runs)` and `2026-11-23 to 2026-12-04`. Never joined with dots or dashes.

### 6.3 2D charts (M9)

| panel | form |
| --- | --- |
| `region-map` | equirectangular land + graticule, circles sized by samples per region, labelled; `aria-label` names it a map |
| `fleet-sankey` | d3-sankey label -> cpuFamily -> region; link colour = label series |
| `fleet-table` / `recent-samples` | ruled tables, tabular numerals |
| `ridgelines` | per metric small multiple; rows = labels, KDE ridges with p50 tick |
| `beeswarm` | per metric, rows = labels, deterministic force-free dodge layout |
| `drift-heatmap` | 24 x 7 grid, sequential ramp on `total.median`, cell text on focus only, `n` per cell in tooltip |
| `slot-ranking` | table of top 5 best and worst with CI bars |
| `neighbours-scatter` | steal x z, OLS line, bucket medians overlaid |
| `neighbours-multiples` | small multiples per label x family |
| `rollout-timeline` | stacked horizontal share bars per day, change-point markers with annotation |
| `changepoints` | ruled table |
| `seasonality-bands` | rolling p10 to p90 band + p50 line per metric |
| `seasonality-effects` | weekday and diurnal effect bars with CIs, ACF stem plot |
| `pointcloud-2d` | fallback: single x mem scatter, point size by write |

One y-axis per chart; bars start at zero; a zoomed axis says so in its caption. Every chart has an `aria-label` summary on its SVG and its data table in a closed "Data table" disclosure under the chart (D-024).

### 6.4 Methods and caveats (`#methods`, static HTML)

Sections: what is measured (each field, units, method); what cannot be known (noisy neighbours on macOS and Windows, virtualized CPU topology, hypervisor preemption, page-cache-influenced read speed, network to GitHub only, `netMbps` as a 1 MiB short-transfer index bounded by slow start and RTT rather than link bandwidth); where region comes from (IMDS vs curated CIDR table matched against `/meta`, never stored IPs); sampling bias (all sweeps at :17, so other minutes are unobserved; dropped scheduled runs are invisible except as missed slots); why steal is only a proxy; statistics (run as unit, bootstrap, tiers, change-point method); privacy guarantees; data downloads (raw JSONL, rollups, schemas).

### 6.5 Frontend contract: `site/src/types/views.ts`

```ts
import type { RollupName, TierId, Manifest, FleetRollup, BenchmarksRollup, DriftRollup, NeighboursRollup, RolloutsRollup, SeasonalityRollup, RegionsRollup } from '../../../shared/types/rollups.ts';

export interface RollupMap { fleet: FleetRollup; benchmarks: BenchmarksRollup; drift: DriftRollup; neighbours: NeighboursRollup; rollouts: RolloutsRollup; seasonality: SeasonalityRollup; regions: RegionsRollup }
export type SheetId = 'fleet' | 'benchmarks' | 'drift' | 'neighbours' | 'rollouts' | 'seasonality';
export type PanelId = 'region-map' | 'fleet-sankey' | 'fleet-table' | 'recent-samples' | 'globe' | 'ridgelines' | 'beeswarm' | 'pointcloud' | 'pointcloud-2d' | 'drift-heatmap' | 'terrain' | 'slot-ranking' | 'neighbours-scatter' | 'neighbours-multiples' | 'rollout-timeline' | 'changepoints' | 'seasonality-bands' | 'seasonality-effects';

export interface ChartTokens {                       // all hex strings, read by site/src/lib/tokens.ts
  paper: string; paper2: string; ink: string; ink2: string; muted: string; rule: string; accent: string; focus: string; warn: string;
  series: readonly [string, string, string, string, string, string];
  sequential: readonly [string, string, string, string, string, string, string];
  diverging: { low: string; mid: string; high: string };
  fontBody: string; fontFigure: string;
}
export interface Caption { n: number; unit: 'samples' | 'runs'; runs?: number; range: { from: string; to: string } | null; note?: string }
export interface RenderContext {
  readonly root: HTMLElement;          // empty element the module owns
  readonly tokens: ChartTokens;
  readonly reducedMotion: boolean;
  readonly signal: AbortSignal;        // aborted before re-render (theme or resize) and on teardown
  readonly width: number;              // content width in px
  announce(message: string): void;     // shell's polite live region
}
export interface ChartModule<D> { readonly panel: PanelId; caption(data: D): Caption; render(ctx: RenderContext, data: D): void }
export interface SceneHandle { setPaused(paused: boolean): void; setTokens(tokens: ChartTokens): void; resize(width: number, height: number): void; dispose(): void }
export interface SceneModule<D> { readonly panel: PanelId; caption(data: D): Caption; mount(ctx: RenderContext, data: D): Promise<SceneHandle> }
export interface PanelDef<R extends RollupName = RollupName> {
  id: PanelId; sheet: SheetId | 'hero'; tier: TierId | 'day0'; rollup: R;
  title: string; question: string;     // sentence case; question is the one sentence the panel answers
  kind: 'chart' | 'scene';
  load(): Promise<{ default: ChartModule<RollupMap[R]> | SceneModule<RollupMap[R]> }>;
  fallback?: () => Promise<{ default: ChartModule<RollupMap[R]> }>;   // required when kind === 'scene'
}
export type { Manifest, RollupName, TierId };
```

Modules default-export their `ChartModule`/`SceneModule`. Shell re-renders charts by aborting the signal, emptying `root`, calling `render` again; scenes get `setTokens`.

### 6.6 Shell behaviour (M8)

- `lib/tokens.ts`: reads `--color-*`, `--chart-1..6`, `--seq-1..7`, `--div-low|mid|high`, `--font-*` via `getComputedStyle(document.documentElement)`; `onTokensChange(cb)` fires on `data-theme` mutation and `prefers-color-scheme` change.
- Theme: button sets `document.documentElement.dataset.theme` to `light`/`dark`, persists `localStorage['atlas-theme']` (try/catch); a 4-line inline head script applies it before paint.
- Panels mount lazily via `IntersectionObserver` (rootMargin 400px), only when their tier is open; data files are fetched once and cached.
- `lib/webgl.ts`: `hasWebGL()` (create a WebGL2 context, else WebGL1, then lose it). Scenes mount only if true; `webglcontextlost` or a thrown `mount` swaps to the fallback and announces it.
- Every panel has four states, rendered by the shell, not the module: **loading** (the neatline frame at the panel's reserved height with its title, question and caption, no spinner), **charting** (the "Charting in progress" panel, section 5), **error** (fetch or parse failed, or `render`/`mount` threw: "This chart could not load. The data file is still available: `<a href=data/rollups/<name>.json>`.", announced once), **full**. A failed rollup fetch is retried once on the next intersection, never in a loop.
- Prerender (no-JS): `transformIndexHtml` fills hero headline answer, title block, Day-0 standby copy and tier statuses from `manifest.json`. Methods is static. With scripting off the page is complete text. It also writes `<meta property="og:image" content="${RUNNER_ATLAS_SITE_URL}og-card.png">`, `og:url`, `twitter:card=summary_large_image`, and the favicon links to `site/public/` files (unhashed, relative).

### 6.7 File ownership

| owner | files |
| --- | --- |
| M2 schemas | `schemas/**`, `shared/types/**` |
| M8 shell | `site/index.html`, `site/vite.config.ts`, `site/src/main.ts`, `site/src/router.ts`, `site/src/data.ts`, `site/src/panels.ts` (registry of all PanelDefs, pointing at M9/M10 paths below), `site/src/lib/**`, `site/src/shell/**`, `site/src/types/views.ts` (verbatim from 6.5), `site/src/styles/{tokens,base,shell}.css` |
| M9 charts | `site/src/charts/<panel-id>.ts` for every 2D panel incl. `pointcloud-2d.ts`, `site/src/charts/_axis.ts`, `site/src/styles/charts.css` |
| M10 scenes | `site/src/scenes/{terrain,pointcloud,globe}.ts`, `site/src/scenes/_common.ts`, `site/src/styles/scenes.css` |
| M7 visual assets (Codex) | `site/assets/**`, `site/public/**` (favicons, `og-card.png`, `site.webmanifest`), `scripts/assets/**`, per DESIGN section 9 |
| M11 audit and docs | `scripts/audit/screenshots.ts`, `audit/screenshots/**`, `audit/hallmark-audit.md`, `README.md`, `SETUP.md`; M7's visual assets are reviewed by a fresh Opus thread immediately in M7 before merging, and the full checklist is recorded in `audit/hallmark-audit.md` in M11 |

A change to `views.ts` or `rollups.ts` is a SPEC change first. Milestones not named here are owned per the orchestration plan; this table only fixes the files whose owner would otherwise be ambiguous.

## 7. Three 3D scenes (M10)

Shared (`_common.ts`): `const THREE = await import('three')` inside `mount`; one `WebGLRenderer({antialias: true})`, pixel ratio capped at 2; orthographic-feel perspective camera (fov 30); materials flat (`MeshLambertMaterial`/`LineBasicMaterial`), no bloom, glow, fog or gradients; colours only from `ChartTokens`. The `<canvas>` has `role="img"` and an `aria-label`; the scene container is `tabindex="0"` with `aria-describedby` instructions. Keys: arrows move the inspection cursor (or rotate where no cursor), `+`/`-` zoom, `0` reset, `Space` pause/resume motion, `Escape` leaves the canvas. Every cursor move calls `announce()` with a full sentence. Each scene has a visible "Show 2D chart" toggle (`aria-pressed`). `prefers-reduced-motion: reduce`: no idle motion, camera moves are instant. Render loop runs only while the panel is in view and not paused.

1. **Cron drift terrain** (`terrain`, fallback `drift-heatmap`): a 24 x 7 heightfield, x = hour, z = weekday, height and colour = `total.median` of `weekdayHour` (cells with 0 runs flat at zero, filled `--color-rule`, no hatching). Contour isolines at `terrain.contours` (d3-contour on the grid, lifted to height) in ink. Peak beacons: thin vertical lines over the 3 worst and best cells, labelled in DOM overlay. Cursor inspects one cell: "Tuesday 04:17 UTC: median wait 41 s, p95 2 min 5 s, 6 runs." Shows diurnal ridges and weekly saddles together.
2. **Benchmark point cloud** (`pointcloud`, fallback `pointcloud-2d`): `points` positioned by normalized `single x write x mem` (each axis scaled to its `domain`), `THREE.Points` coloured by cpuFamily series, axes as ink lines with DOM labels. Cursor cycles family centroids and outliers (|z| > 3); legend toggles families. Shows cluster separation and stragglers that 1D ridgelines hide.
3. **Fleet telemetry globe** (`globe`, fallback `region-map`): graticule every 15 degrees and land outlines from bundled `world-atlas` lines on a sphere in `--color-paper2`; one pylon per region, height = samples, ring radius = median TTFB, colour = sequential ramp on median total delay. Idle rotation 6 degrees/s with a visible pause button; pauses on hover and focus; none under reduced motion. Cursor steps through regions by sample volume.

Bundle rule: the entry chunk and its static imports contain no `three` module (checked against `dist/.vite/manifest.json`). Entry JS budget <= 90 KB gzip, excluding fonts.

## 8. Verification

| check | command | local | CI (`ci.yml`) | atlas publish |
| --- | --- | --- | --- | --- |
| typecheck | `npm run typecheck` (`tsc --noEmit`) | yes | yes | no |
| unit | `npm test` (`vitest run`, `tests/unit`): raw-sample parsing and the collector parsers (`/proc/cpuinfo`, `lscpu`, `sysctl`, `os-release` fixtures), privacy scan, schema fixtures, quantiles, MAD, KDE fallbacks, MWU vs reference values, BH, bootstrap determinism, Spearman, rollups on small fixtures, slot score and confidence tiers, tier gating and `opensOn`, `surveyDay` across midnight, drift (`scheduledSlotIso`, `cronDriftSec`, run-level `D_r`), field log templates, probe file SHA-256 | yes | yes | no |
| collector smoke | `node collector/src/collect.ts --local --out .tmp/sample.json` then ajv schema-validate; asserts <= 1600 bytes, `benchmarkDurationMs <= 20000`, no IP-like strings, `netProbe` is `meta` or `null` | yes (dev OS) | ubuntu only | every job (structural self-check before upload, section 2); ajv in publish |
| rollup determinism | Vitest (`tests/integration`): aggregate fixtures twice, byte-compare; empty raw reproduces committed Day-0 rollups | yes | yes | no |
| synthetic tiers | Vitest (`tests/integration`): generate days 0,1,3,7,14,30,90, aggregate, validate all rollups, assert tier statuses per section 5 | yes | yes | no |
| schema | validate `data/rollups/*.json` | yes | yes | yes (before commit) |
| workflow | `actionlint`; SHA-pin grep | optional | yes | no |
| no colour literals in TS | grep `site/src/**/*.ts` for `#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(` = 0 hits | yes | yes | no |
| Hallmark | `node .claude/skills/hallmark/scripts/sloplint.mjs site/index.html site/src/styles --scope app --genre modern-minimal`; render tier with `--render --url http://localhost:5173/` against `vite dev` (built CSS loses the stamp comment) | yes | static tier | no |
| bundle | build, inspect manifest: no `three` in entry graph, entry <= 90 KB gz | yes | yes | build only |
| e2e (Playwright, Chromium) against `vite preview` of `.tmp/synthetic/day-90` and Day-0 builds | fold: hero headline, sentence, answer and primary action inside 1280 x 800; no horizontal scroll at 320, 375, 768, 1280, 1440, 1920; offline: every non-localhost request aborted and counted (must be 0); JS disabled: hero, title block and Methods present; reduced motion: no running CSS animations, globe not rotating; `--disable-webgl`: all 3 fallbacks render and are announced; keyboard: Tab reaches each scene, arrows announce; both themes: axe-core contrast clean | yes | yes | no |

`npm run verify` runs every local row. Vitest never imports Playwright specs (`vitest.config.ts` excludes `tests/e2e`); `npm run e2e` runs Playwright. Vitest is a dev dependency only: collector jobs never run `npm ci` (D-014, D-018).

Audit screenshots (M11): `node scripts/audit/screenshots.ts` builds `.tmp/synthetic/day-{0,1,3,7,14,30,90}`, serves each with `vite preview`, and writes `audit/screenshots/day-<d>-<width>-<theme>.png` at widths 375, 1280 and 1440 in light and dark, plus `day-90-1280-light-nowebgl.png`, the three 3D scene captures (`day-90-3d-terrain.png`, `day-90-3d-pointcloud.png`, `day-90-3d-globe.png`) and `day-90-methods.png`: 47 files. Requests leaving localhost are aborted. Screenshots come from the synthetic presets only and show the synthetic notice. `audit/hallmark-audit.md` records the sloplint run (static and render tiers), every waiver, answer and dismissal, the hero and finish review outcomes, and the M7 asset review checklist (DESIGN section 9).
