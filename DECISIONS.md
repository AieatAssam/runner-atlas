# Decisions

Append-only log. Each entry: context, decision, consequences. Supersede an entry with a new one; never edit an old decision's substance.

## D-001 Matrix of 11 jobs, 3 macOS (2026-11-22)

Context: free public repos allow 20 concurrent jobs and 5 concurrent macOS jobs. Hourly runs must never queue behind themselves or starve a human's CI.
Decision: `ubuntu-24.04` x3, `ubuntu-24.04-arm` x2, `windows-2025` x2, `windows-11-arm` x1, `macos-15` x2, `macos-15-intel` x1. Replicas give within-run variance on the most common labels; optional labels get one.
Consequences: 11 collectors plus 3 small orchestration jobs, 3 macOS: 9 jobs and 2 macOS slots of headroom. About 264 samples a day, 9,000 by day 34 at full coverage.

## D-002 Cron gate `RUNNER_ATLAS_CRON_ENABLED` (2026-11-22)

Context: hourly runs commit to `main`. A broken collector on one OS would commit bad data 24 times a day before anyone notices.
Decision: the `plan` job runs on `schedule` only when `vars.RUNNER_ATLAS_CRON_ENABLED == 'true'`; `workflow_dispatch` always runs. The owner verifies a dispatch run on every OS (SETUP.md), then sets the variable.
Consequences: a fresh fork is inert until enabled. Disabling is one variable change, no commit.

## D-003 Dynamic matrix via a `plan` job and `RUNNER_ATLAS_DISABLED_LABELS` (2026-11-22)

Context: `matrix` is unavailable in a job-level `if`, and a retired hosted label can leave a job queued for up to 24 hours, which would hold the publish job.
Decision: `collector/matrix.json` is the single source; `plan` filters out labels listed in the comma-separated variable and emits the matrix. Optional labels also use `continue-on-error`.
Consequences: one extra short job per run; retiring a label needs no commit.

## D-004 `data/` holds only real data (2026-11-22)

Context: synthetic data in the repo could be mistaken for measurements and would pollute history.
Decision: `data/raw/` ships empty (`.gitkeep`); `data/rollups/` ships the Day-0 output of the aggregator over an empty raw directory. The synthetic generator writes only to a chosen directory such as `.tmp/synthetic/day-90/` (gitignored), marks samples `src: "synthetic"`, and the site labels synthetic builds on screen.
Consequences: the live site starts at the "Awaiting first sweep" state. Screenshots and audits run against synthetic builds.

## D-005 D3 + d3-sankey, bundled world-atlas, no UI framework (2026-11-22)

Context: the cartographic look needs per-mark token control, and the site must render offline (Playwright audits block external requests) with zero tile calls.
Decision: D3 modules plus `d3-sankey` rather than Observable Plot; `world-atlas` `land-110m.json` and `topojson-client` bundled; vanilla TypeScript DOM. Three.js only via dynamic `import()`.
Consequences: more chart code per panel, full styling control, no runtime CDN dependency.

## D-006 Vendored skills in `.claude/skills/` (2026-11-22)

Context: design and review rules must be the same for every thread and reproducible.
Decision: `hallmark`, `frontend-design` and `impeccable` are copied into the repo at the commits in `skills-lock.json`. `sloplint.mjs` runs from the vendored path in CI.
Consequences: upgrades are explicit commits; no thread depends on a user-level install.

## D-007 The run is the unit for delay statistics (2026-11-22)

Context: all jobs in one run share one scheduled slot and one creation time. Bootstrapping over jobs would treat 11 copies of one drift as 11 observations.
Decision: per-run delay is the median over the run's jobs; cell `n` counts runs; bootstraps resample runs. A cell needs 3 runs; the headline pools by hour until 70% of weekday x hour cells qualify.
Consequences: weekday-level headlines arrive around day 21, not day 7. Confidence tiers are honest.

## D-008 Deterministic rollups (2026-11-22)

Context: rollups are rebuilt and committed hourly; nondeterminism would churn diffs and flake tests.
Decision: no wall clock, seeded `mulberry32(fnv1a32(key))` per statistic, hash-ordered subsamples, fixed rounding, fixed key order, compact JSON.
Consequences: identical raw input gives byte-identical rollups; tested.

## D-009 Hallmark Floor beats brief wording where they collide (2026-11-22)

Context: the brief's date range format `YYYY-MM-DD — YYYY-MM-DD` uses an em dash, which sloplint gate 19 fails in copy; "unlock" is on its buzzword list; `data-viz.md` discourages 3D and chart libraries and limits hues.
Decision: ranges render as `2026-11-23 to 2026-12-04`; UI copy says "opens" and "Charting in progress", while JSON keys may still say tier or unlock; captions use two lines, never middle dots. The brief's explicit 3D scenes and D3 stand, each with a first-class 2D fallback. Six series are declared as `posture: full-palette` in the stamp.
Consequences: SPEC and DESIGN use these forms everywhere.

## D-010 Stamp as app screen, fold enforced by our own test (2026-11-22)

Context: Hallmark classifies a dashboard as an app screen (`shape: app screen`), whose sloplint scope skips the hero/fold (44b) and the word budget (58). The brief still requires the 1280 x 800 fold.
Decision: stamp `shape: app screen`; a Playwright test asserts headline, sentence, answer and primary action inside 1280 x 800. sloplint runs against source (`site/index.html` + `site/src/styles`) and its render tier against `vite dev`, because minified CSS drops the line-1 stamp.
Consequences: the Methods page may hold long prose without fighting gate 58.

## D-011 Egress IP lookup uses Cloudflare's trace endpoint (2026-11-22)

Context: CIDR region inference needs the runner's egress IP when IMDS is unreachable (expected on macOS). No GitHub-owned IP echo endpoint is known.
Decision: one `GET https://1.1.1.1/cdn-cgi/trace` (2000 ms), parse only `ip=`, keep it in memory, match, drop. Called only when IMDS fails. Region comes only from the curated CIDR table; GitHub `/meta` ranges confirm the Actions pool but carry no region.
Consequences: one third-party request per such job. If this becomes unacceptable, the fallback is to skip inference (`method: "none"`), which needs no schema change.

## D-012 Chart tokens in hex, UI tokens in OKLCH (2026-11-22)

Context: D3 colour parsing and `THREE.Color` read computed custom properties as the declared string and do not parse `oklch()`.
Decision: `--chart-*`, `--seq-*`, `--div-*` are hex (computed from OKLCH sources); UI tokens stay OKLCH. `site/src/lib/tokens.ts` is the only reader; a grep gate bans colour literals in `site/src/**/*.ts`.
Consequences: themes switch charts and scenes by re-reading tokens.

## D-013 Textures are real geometry (2026-11-22)

Superseded by D-019.

Context: the brief asked for paper/topographic texture overlays; Hallmark's custom direction refuses paper or grain as a surface, and texture on a modern-minimal page.
Decision: no raster texture, no grain. "Plates" are generated graticule and data contours at low opacity.
Consequences: the archival feel comes from colour, neatlines and type, not noise.

## D-014 Zero-dependency collector on Node 22 type stripping (2026-11-22)

Context: each collector job should start fast and carry no supply-chain surface.
Decision: the collector uses only Node built-ins and runs as `.ts` via native type stripping (Node 22.18+, `erasableSyntaxOnly`). No `npm ci` in collector jobs. The aggregator may use `ajv`.
Consequences: no enums or parameter properties; imports use `.ts` extensions.

## D-015 Publish concurrency and push retry (2026-11-22)

Context: a dispatch run can overlap a scheduled run.
Decision: publish runs in group `runner-atlas-publish` with `cancel-in-progress: false`; on a rejected push it resets to `origin/main`, re-ingests and retries up to 3 times. GitHub keeps one pending job per group, so a third overlapping run replaces the older pending one; those samples are lost and accepted.
Consequences: no lost commits, no merge conflicts in derived files.

## D-016 Fonts: Hepta Slab, Public Sans, IBM Plex Mono, self-hosted (2026-11-22)

Context: the display face must be one no Hallmark catalog theme uses (checked clear), and fonts must load offline.
Decision: Hepta Slab (slab serif, survey title-block voice), Public Sans (US federal design system lineage, fits survey documents), IBM Plex Mono for figures only. All via Fontsource npm packages.
Consequences: no Google Fonts request; three families, the mono carrying one role.

## D-017 Process note: Step 0A stall and retry (2026-11-22)

Context: the first authoring turn for these documents read all vendored skills, computed palette contrast and took review advice, then stalled before writing files.
Decision: on retry the files were written directly from the completed analysis without re-reading sources. Analysis carried over: run-level drift unit, deterministic rollups, Floor-vs-brief resolutions, hex data tokens, prerender for no-JS, named egress endpoint, file ownership map.
Consequences: none on the design; recorded so later threads know the documents were written in one pass after a restart.

## D-018 Vitest for unit and integration tests (2026-11-22)

Context: the brief names Vitest for unit tests of parsing, aggregation, rollups, tier logic and drift; the first SPEC draft said `node:test`.
Decision: `npm test` runs `vitest run` over `tests/unit` and `tests/integration`; `vitest.config.ts` excludes `tests/e2e`, which Playwright runs. Vitest is a dev dependency.
Consequences: D-014 stands: collector jobs never run `npm ci`, and the collector still imports only Node built-ins. Only `ci.yml` and the `publish` job install dev dependencies.

## D-019 Generated visual assets as alpha-only plates (supersedes D-013) (2026-11-22)

Context: the brief has Codex CLI generate the emblem, favicons, social card, section icons, textures and illustrative artwork, with an Opus thread reviewing and committing them under `site/assets/`. D-013 ruled out any raster texture. sloplint never opens image files, so the files need their own acceptance rule; Hallmark's refusal of grain, paper and imitation material still binds.
Decision: rasters are allowed. A "texture" is a plate of survey geometry or real geography (graticule, contours of a real landform, triangulation network), shipped alpha-only and painted with `mask-image` plus a colour token, at <= 0.12 opacity, `aria-hidden`. Grain, noise, fibre, gradients and drawn instruments stay banned. The one illustration is a survey plate of real region locations. Text on the social card is rendered from an HTML template with the bundled fonts. M11 accepts each file against the checklist in DESIGN section 9; files needing unhashed URLs (favicons, `og-card.png`) live in `site/public/`.
Consequences: every colour in an asset still resolves to a token; plates recolour in dark mode with no second file. M7 owns `site/assets/**`, `site/public/**` and `scripts/assets/**`; M11 owns the screenshot harness, audit and docs.

## D-020 Throughput probe fallback and `netProbe` (2026-11-22)

Context: the probe URL needs `GITHUB_REPOSITORY` and a pushed `GITHUB_SHA`, which `--local` runs and unpushed forks lack. A fallback body of another size and encoding is not comparable.
Decision: fall back to `https://api.github.com/meta` (GitHub-owned, already used for region inference) when the variables are missing or raw answers non-200 or the wrong length. Both requests send `accept-encoding: identity`. The sample records `bench.netProbe: "repo" | "meta" | null`, and rollups compute `netMbps` from `repo` samples only. The probe file is 1 MiB of seeded PRNG output (incompressible, reproducible, SHA-pinned by a test) and is left out of the collect job's sparse checkout.
Consequences: one more schema field (about 20 bytes). Local runs exercise the whole net step without polluting statistics.

## D-021 Contract tightening from the Step 0 review (2026-11-22)

Context: an independent review of SPEC found gaps that would surface as schema or rendering bugs.
Decision: `surveyDay` counts calendar UTC dates so it agrees with `opensOn` and the daily field log; field log rule 3 states its own expected-slot count instead of "of 24"; `singleCoreScore`, `multiCoreScore` and `memBandwidthGBs` are nullable when their step is truncated; benchmark `domain` may be null, KDE has defined fallbacks for zero spread; day-aligned arrays carry `null` on gap days; effect rows, ACF lags and Day-0 `Record`s have fixed lengths and key sets; the in-job collector check is structural with full ajv validation in `publish`; `publish` checks out with `persist-credentials: true` while `collect` uses `false`; every panel has loading, charting, error and full states.
Consequences: the schemas in M2 follow SPEC section 4.2 as amended; no prior decision changes.

## D-022 Toolchain majors: TypeScript 7, Vite 8, Vitest 5 (2026-11-22)

Context: M3 installed the current majors: `typescript@7` (native compiler), `vite@8` (Rolldown), `vitest@5`, `@playwright/test@1.65`. SPEC names the tools but not versions.
Decision: keep them. TypeScript 7 rejects enums, parameter properties and value imports of types under the repo `tsconfig.json`, so `npm run typecheck` still guards Node type stripping (D-014). Vite, Vitest and `@axe-core/playwright` need Node `>=22.12`; `engines` asks for `>=22.18.0`, so CI's Node 22 covers them.
Consequences: TypeScript 7 checks side-effect imports by default, so `import './x.css'` fails typecheck until M8 adds a `*.css` module declaration (or `vite/client` types). `npm run preview` binds `127.0.0.1` so Playwright's `webServer` URL matches on hosts where `localhost` resolves to `::1`.

## D-023 Wave A and Wave B sub-orchestration offloaded to Claude Fable 5.2; M7 asset outcome (2026-11-23)

Context: the user asked the lead orchestrator to hand the review, fix-loop, merge and verification work for Wave A (M4 to M7) and Wave B to Claude Fable 5.2 sub-orchestrators. The sub-orchestrator writes no feature code: workers build in worktrees, a fresh Claude Opus 5.5 thread that did not write the component reviews it, and approved branches are squash-merged onto `main`.
Decision: Wave A ran that way. M4, M5 and M6 each passed one Opus review, with the reviewer committing fixes on the branch. M7 stayed with the Codex worker (native image generation was available, so no Haiku fallback ran) and took six Opus review rounds. The first contour plate was an image-model drawing with no checkable source and was rejected as invented terrain; it was replaced by 200 m index contours computed with d3-contour from a USGS 3DEP grid of Mount Rainier committed under `scripts/assets/`. The emblem, favicon set, rollouts glyph and survey plate were redrawn until they passed measured tests. Every shipped raster is now rendered by a committed, byte-reproducible script; no image-model pixels ship.
Consequences: `NOTICE` names the 3DEP tile and lists the generated assets. `scripts/assets/check-plates-and-emblem.ts` holds the binding tests from the reviews (emblem triangle legibility at 20 and 24 px, contour artefact limits, survey plate edge angle and node clearance, no alpha plateau) and should run in M11's asset audit. Open items carried to later milestones: `ci.yml` lacks the SPEC 8 collector smoke, rollup schema and bundle size steps, which need scripts from later milestones; `e2e`, sloplint and bundle steps fail until M8 and M11 land; the generator for `collector/data/region-cidrs.json` is not committed; a weekly cycle in delay can surface as a change point (SPEC 4.6); run identity ignores `runAttempt` (SPEC 4.1).

## D-024 M11 audit fixes: chart tables, pinned columns, wide panels, field log, docs (2026-11-23)

Context: the M11 Hallmark audit (`audit/hallmark-audit.md`) and the independent review turned up render-tier findings and contract drift. This entry records each change that departs from SPEC or DESIGN.

Decision:
- Data tables. A chart's summary table no longer sits in a 1 px sr-only box. Gate 73 hit-tested its clipped header cells as text painted under another element. The table now sits in a closed "Data table" `<details>` under each chart. A closed table is `display: none`, so nothing measures it. The SVG keeps its `aria-label` summary and each mark keeps its own label. This amends SPEC 6.3.
- Pinned first column. On a phone each ruled table keeps its first column (the runner label or date that names the row) pinned with `position: sticky` while the other columns scroll inside a focusable region. This amends DESIGN 5. It is also the stamp's answer to Finish check F25 (columns off-screen at 375).
- Wide panels. `fleet-table`, `recent-samples`, `ridgelines` and `beeswarm` are `panel--wide`. In half panels the two tables scrolled sideways at 1440, and gate 73 read their clipped cells as overlapped text. The tall ridgelines also left an empty column beside them.
- Field log. The site shows the latest 7 days, with the older days in a closed "Earlier entries (n)" disclosure. Runner labels never break at a hyphen. Change-point sentences name the series by its display name (SPEC 4.8 rule 6, amended). The change-points caption spells out the test ("Mann-Whitney U test, false discovery rate 5%").
- Hero answer. The best and worst slot and their wait scores are set at weight 600 in ink, with their digits in IBM Plex Mono. On phones the headline steps down one size, so the answer reaches the first screen.
- Globe. The globe starts, and resets, facing the sample-weighted mean longitude of the regions, so the pylons stand face-on.
- Synthetic image versions. Names derive from `--start` (old image 14 days before it, new image on rollout day 20), so no version postdates the survey it appears in.
- Screenshot gallery. The gallery covers days 0, 1, 3, 7, 14, 30 and 90 (SPEC 8): 47 files.
- Repository link. When `RUNNER_ATLAS_REPO_URL` is unset, the site defaults it from `GITHUB_SERVER_URL`/`GITHUB_REPOSITORY`. Before this, `atlas.yml` never set it, so the live site had no repository link.
- Dev dependencies. `happy-dom` (MIT) backs the chart unit tests, and `@axe-core/playwright` (MPL-2.0, test-time only) backs the accessibility e2e tests. Both are listed in `THIRD_PARTY_LICENSES.md`.

Consequences: sloplint stays clean on static, and on render for Day-0 and Day-90, with one answered F25. The hero and finish reviews left some findings unresolved or dismissed, with reasons in `audit/hallmark-audit.md`. They challenge the locked composition (the boxed-panel rhythm, the paired ridgeline and beeswarm, a caption with n and range on every chart) and are left to a later design decision, not to M11.

## D-025 Public GitHub repository creation, Pages, Actions, and branch ruleset (2026-11-23)

Context: the repo owner granted explicit permission to use `gh` CLI to publish the public repository (`AieatAssam/runner-atlas`), configure GitHub Pages, set Actions and metadata policies, protect `main`, and verify the live workflow dispatch.
Decision: create `AieatAssam/runner-atlas` as a public repo with description, topics, and homepage (`https://aieatassam.github.io/runner-atlas/`); enable GitHub Pages with `build_type: workflow` (GitHub Actions source); restrict Actions to GitHub-owned actions (`actions/*`) with default `read` workflow permissions (jobs request least-privilege overrides only where needed); enforce an active branch ruleset (`Protect main`) with `deletion` and `non_fast_forward` rules so history cannot be deleted or force-pushed while `github-actions[bot]` fast-forward `data: sweep` commits succeed cleanly without bypasses. Run an initial `workflow_dispatch` sweep across the matrix before setting `RUNNER_ATLAS_CRON_ENABLED=true`.
Consequences: the repo is live on GitHub, protected against destructive history changes, and verified end-to-end against real GitHub-hosted runners before hourly commits start.

## D-026 First live sweep fixes: IMDS region case, Azure coordinates, CPU families, Day-0 fixture (2026-11-23)

Context: the first live GitHub Actions sweep (run `45111988784`, commit `fdba9b9`) produced 11 real samples in `data/raw/2026/11/23.jsonl`. It exposed four gaps. Azure IMDS reports mixed-case region names (`ChileCentral`, `WestUS3`) that did not match the lowercase coordinate keys, so those samples fell into `unknown`. Several Azure GA regions had no coordinates, including `westcentralus` and `chilecentral`. AWS-hosted `ubuntu-24.04` runs an Intel Xeon 6975P-C, and Azure `windows-11-arm` runs a Microsoft Cobalt 100, and neither mapped to a known CPU family. Separately, the Playwright `day-0` fixture read `data/rollups/`, which now holds live data, so the e2e check no longer matched an empty Day-0 build.

Decision:
- Region keys. `regionKey` trims and lowercases the region (IMDS, then CIDR inference). Coordinate keys stay lowercase. Samples with no region still count as `unknown`.
- Coordinates. `aggregator/data/region-coords.json` gains the observed `westcentralus` and `chilecentral` regions, plus 18 other active Azure GA regions (`mexicocentral`, `brazilsoutheast`, `switzerlandwest`, `germanynorth`, `norwaywest`, `francesouth`, `austriaeast`, `belgiumcentral`, `denmarkeast`, `israelcentral`, `qatarcentral`, `uaecentral`, `westindia`, `koreasouth`, `malaysiawest`, `indonesiacentral`, `newzealandnorth`, `australiacentral`) and `us-west-1` added ahead of need. Existing entries are unchanged.
- CPU families. `cpuFamily` adds numbered Intel Xeon families without a tier name (`Intel Xeon 6975P-C`), Neoverse `N` and `V` series, and Microsoft Cobalt (`Microsoft Cobalt 100`). Existing synthetic family strings are unchanged. The collector maps `Cobalt` brands to vendor `Microsoft`.
- Day-0 fixture. `rollupsFor('day-0')` no longer reads `data/rollups/`. It writes the empty Day-0 build into `.tmp/fixtures/day-0/rollups` on each call, so e2e does not depend on live data. Nothing writes into `data/` from the fixture.
- Integration test. The committed `data/rollups/` must equal a fresh build from `data/raw/` byte for byte, and it must validate against the schemas. Every raw sample must have `src: live` (D-004). A separate block checks the empty Day-0 build (survey day 0, source `empty`, no open tiers, zero samples, deterministic bytes).

Consequences: `data/rollups/` now reflects the live sweep (11 samples, 6 labels, 6 IMDS regions with 5 non-IMDS macOS and AWS samples still in `unknown` because CIDR matching gives no region, zero unknown CPU families). Future live sweeps rebuild `data/rollups/` and the test follows them, so the test no longer pins Day-0. Unrecognised CPU models still map to `unknown`; add a rule when one appears in a sweep.

## D-027 Region table split lookup, generator, and passive agent-version discovery (2026-11-23)

Context: the egress lookup in `collector/src/region.ts` merged the curated table and GitHub `/meta` into one list. GitHub's narrower `/24` ranges (region `null`) then hid the curated AWS `/17` entries (`us-east-1`, `us-west-2`), so those samples lost their region. `collector/data/region-cidrs.json` had no reproducible source, and the first sweeps reported `null` for agent version on hosted images that keep the runner under `runners/<semver>`. The committed AWS and Azure coordinate table also lacked several standard AWS GA regions.

Decision:
- Lookup. `inferFromEgress` matches the curated table and `/meta` separately. `matchedCidr` is the most specific range across both, and a prefix tie keeps the table. `inferredRegion` comes only from the table (`null` for a `/meta`-only match). This is the SPEC 3.4 rule, applied per source.
- Generator. `scripts/build-region-cidrs.ts` rebuilds `collector/data/region-cidrs.json` from AWS `ip-ranges.json` (EC2 rows, IPv4 and IPv6) and Azure Service Tags (`AzureCloud.*` rows). It uses no npm packages and writes deterministically (sorted by provider, cidr, region). Azure short names are canonicalized to ARM names (`centralfrance` to `francecentral`, `chilec` to `chilecentral`, and so on). The `source` value is `azure-service-tags-<ServiceTags file name>`. The script refuses to write when either provider has no rows.
- Coordinates. `aggregator/data/region-coords.json` gains eight standard AWS GA regions: `ca-central-1`, `eu-west-2`, `eu-west-3`, `eu-north-1`, `ap-south-1`, `ap-northeast-2`, `ap-southeast-2`, `sa-east-1`. Existing keys are unchanged.
- Agent version. `readAgentVersion` picks the highest numeric semver (`compareSemver`) from runner directories and `bin.<semver>` roots. It then looks for an active `Runner.Worker` or `Runner.Listener` process (process ancestors up to 8 levels on Linux and macOS, CIM lookup on Windows). The path is read in memory and never logged or stored. The direct `--version` check runs last. Each attempt is capped at 2000 ms, which amends the 1000 ms limit in SPEC 3.3 for `--version` and the PowerShell lookup.
- Workflow. The hourly cron trigger in `.github/workflows/atlas.yml` has a comment explaining the :17 offset (D-002). Its logic is unchanged.

Consequences: the committed table now holds the AWS EC2 and Azure `AzureCloud.*` ranges from one generator run (22262 rows, from 14633). It has no `/32` IPv4 or `/128` IPv6 rows. One IPv6 `/32` row is kept, since the rule excludes only IPv4 `/32` and IPv6 `/128`. Regions published without coordinates still fall back to `unknown` in the aggregator. The `NOTICE` text already names these sources and stays accurate. The raw samples and rollups are unchanged.
