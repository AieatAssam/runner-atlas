# Hallmark audit: Runner Atlas, Milestone 11

## Scope

- **Date:** 2026-11-23. Base commit `927981f`; the M11 work is uncommitted on `main`.
- **Pages:** `site/index.html` (the dashboard, with Methods and caveats as a section of the same page), its
  stylesheets in `site/src/styles/`, and the chart and scene code that draws into it.
- **Data states:**
  - Day-0: the committed `data/rollups/`, with no samples.
  - Days 1, 3, 7, 14, 30 and 90: synthetic presets from `scripts/synthetic/generate.ts`, seed 7, starting
    2026-01-05. Every synthetic page shows "Synthetic sample data, not measurements."
- **Tools:**
  - Hallmark `sloplint.mjs` v2.0.0 with `--scope app --genre modern-minimal`. The render tier ran in Chrome
    for Testing against `vite dev` on `127.0.0.1:5173`.
  - Playwright for the 47-image gallery in `audit/screenshots/`. The gallery's Day-0 is synthetic preset 0, so it
    carries the synthetic notice; the Day-0 render tier and the prerender check use the committed rollups.
  - Two fresh-context subagents for the hero and finish reviews (`gates.md` § 6).

## Sloplint output

### Final runs (after every fix below)

Static tier:

```
sloplint: clean. 0 FAIL, 0 REFLEX, 0 WARN across 6 file(s).
```

Render tier, Day-90 (`RUNNER_ATLAS_ROLLUPS_DIR=.tmp/synthetic/day-90/rollups`):

```
render tier: 5 screenshots in /Users/aieat/git/runner-atlas/.hallmark/shots (1280x800, 1440x900, 1920x1080 folds; 1440 and 375 full pages)
http://127.0.0.1:5173/
  ANSWERED F25 :1 [375px] a table opens with 11 columns off-screen (from "Runs")
sloplint: 0 FAIL, 0 WARN, 1 ANSWERED across 6 file(s) and 1 URL(s).
```

Render tier, Day-0 (committed rollups):

```
render tier: 5 screenshots in /Users/aieat/git/runner-atlas/.hallmark/shots (1280x800, 1440x900, 1920x1080 folds; 1440 and 375 full pages)
sloplint: clean. 0 FAIL, 0 REFLEX, 0 WARN across 6 file(s) and 1 URL(s).
```

Hero stage, Day-90 (re-run after the label fix loops):

```
render tier: 4 hero screenshots in /Users/aieat/git/runner-atlas/.hallmark/shots (1280x800, 1440x900, 1920x1080 and 375x812 first screens)
sloplint: clean. 0 FAIL, 0 REFLEX, 0 WARN across 6 file(s) and 1 URL(s) (hero stage).
```

### First runs (before the fixes)

Day-90 render tier, first run:

```
FAIL 73 :1 [1440px] text painted under another element: span over "Region"; span over "Samples"; span over "Share"
WARN F25 :1 [375px] a table opens with 29 columns off-screen (from "Median start delay")
```

Day-90 render tier, after the first fix:

```
FAIL 73 :1 [1440px] text painted under another element: td over "16.0 GB"; td over "16.0 GB"; td over "16.0 GB"
WARN F25 :1 [375px] 516 words hidden on a phone (first: "Monday 00:17 UTC")
WARN F25 :1 [375px] a table opens with 26 columns off-screen
```

Day-0 render tier, first run: one `REFLEX 49b`. The standby link "Read how the survey measures runners"
wrapped onto a second line at 320 px.

## Gate 73 and F25: what was wrong and how each was settled

**Gate 73, first cause (Floor, cannot be waived).** Each chart's summary table sat in a 1 px `sr-only`
box. The gate's text walker skips `[hidden]`, `[aria-hidden]` and closed `<details>`. It does not skip
text clipped by `overflow` or a 1 px clip, so it hit-tested the table headers ("Region", "Samples",
"Share") and found the clipping `span` on top.

The gate was right that real text sat behind something. The fix:

- Every summary table now sits in a closed "Data table" `<details>` under its chart
  (`site/src/charts/_axis.ts`, `summaryTable`).
- A closed table is `display: none` (`site/src/styles/charts.css`, `.chart__data:not([open]) > .table-wrap`),
  so nothing measures or hit-tests it.
- The SVG keeps its `aria-label` summary, and every mark keeps its own label.
- The disclosure has hover, active, focus-visible and open states and a 32 px target.
- Screen-reader users hear "Data table: <caption>".

**Gate 73, second cause.** `fleet-table` sat in a half-width panel, so at 1440 its columns scrolled sideways
inside the panel. The clipped "16.0 GB" cells lay under the neighbouring `recent-samples` table, which
`elementFromPoint` returned.

The fix makes `fleet-table`, `recent-samples`, `ridgelines` and `beeswarm` wide panels
(`site/index.html`). The two tables now fit at 1440 without scrolling. The tall ridgelines no longer leave
an empty column beside them.

**F25, "516 words hidden on a phone".** Closed `<details>` content still had layout boxes. The same
`display: none` rule fixed it.

**F25, columns off-screen at 375 (Finish).** This is answered, not waived. On a phone the ruled tables
(fleet by label, recent samples, change points, and any opened data table) scroll inside a focusable region
with `role="region"` and an `aria-label`. Their first column, the runner label or date that names the row,
is pinned with `position: sticky`. The gate's own fix text offers "pin the first column". The answer is in
the stamp (`site/src/styles/tokens.css`, line 3):

```
/* Hallmark · answered F25 · on a phone each ruled table keeps its first column, the runner label or date that names the row, pinned with position sticky while the other columns scroll inside a focusable table region */
```

Evidence:

- The 375 px shots show the label column in place while the other columns sit to its right.
- The e2e layout test finds no box past the viewport outside a scrolling ancestor at 320, 375, 768, 1280,
  1440 or 1920 px. Its control check proves the scanner does catch an injected 2000 px element.

**REFLEX 49b, Day-0.** The standby link now reads "How runners are measured" and fits on one line at 320 px.

**Waivers:** none. **Dismissals:** none at the sloplint level.

## Hero review

The reviewer was a fresh subagent given the four `hero-*` shots, the stamp's first two lines, and the
Material and Signature rows from DESIGN. First word: **`fix`**, with 5 findings.

| # | Finding | Settled | Score |
| --- | --- | --- | --- |
| 1 | The best and worst slots were plain body text. The 6 s and 28 s figures had no weight, so the title block drew the eye first. | The CSS already defined `.answer__figure`, but no markup used it. The prerender now sets each slot and wait score at weight 600 in ink, with their digits in IBM Plex Mono. The two answer lines are one type step larger (`site/vite.config.ts`, `slotMarkup`; `site/src/styles/shell.css`). | resolved |
| 2 | The map does not show when the best or worst slot falls, and eastus and eastus2 merge into one blob. | Not changed. DESIGN § 5 fixes the hero as the answer beside the title block and the region map. The map answers "where", the answer answers "when", and redrawing the hero visual is a design decision outside M11. The two labels no longer overlap (second fix pass, below), but the circles still merge: the two regions sit 0.7° of latitude and 1.4° of longitude apart (`aggregator/data/region-coords.json`). | unresolved |
| 3 | The layout reads as a model default: bordered cards and an orphan "Data table" label. | Not changed. This is the locked DESIGN composition, and the "Data table" disclosure is the chart's accessible table. | unresolved |
| 4 | Empty band under the left column at 1280 to 1920. | The larger answer lines shorten it by about 60 px. A band of about 180 px remains at 1440. | partial |
| 5 | At 375 the headline took five lines and the answer missed the first screen. | Below 30 rem the headline steps down to `--text-6` and sets in four lines. The best and worst slots now fall inside the 375 x 812 first screen. The map still stacks below, as the one-column layout requires. | resolved |

Stamp record: `hero-review: fix · 5 findings · 2 resolved 1 partial 2 unresolved`.

## Finish review

The reviewer was a fresh subagent. Its first attempt answered **`recapture`**: the render tier's full-page
shots wrap at Chrome's 16,384 px limit and repeat the top of the page, so everything below about 16,000 px
was missing. That run did not count as the one review round. The second reviewer read the complete
Playwright full pages (`audit/screenshots/day-90-1440-*.png` and `day-90-375-*.png`), the fold shots, the
HTML and CSS, the stamp idea line, `gates.md` § 4 and the hero findings. First word: **`fix`**, with
8 findings.

| # | Finding | Settled | Score |
| --- | --- | --- | --- |
| 1 | "Speed by label" (ridgelines) and "Runs by label" (beeswarm) plot the same six metrics one after the other. | Not changed. SPEC § 5 defines both as separate day-3 panels: one shows distribution shape, the other individual runs and stragglers. Merging them is a spec change. | unresolved |
| 2 | Field log: 14 template entries in a narrow column. The reviewer cited gate 58. | Now the latest 7 days, with older days in a closed "Earlier entries (n)" disclosure. Labels no longer break at a hyphen, and change-point sentences use display names ("Single core score", not `singleCoreScore`). The sentence templates are SPEC 4.8. Gate 58 does not apply at app scope. | partial |
| 3 | Methods is a narrow column beside empty space (gate 77). | Not changed. The column is the 68 ch reading measure from DESIGN § 4. Gate 77 does not apply at app scope. | unresolved |
| 4 | The globe opens facing Africa, with every pylon side-on at the limb. | The globe now starts, and resets, facing the sample-weighted mean longitude of the regions (`site/src/scenes/globe.ts`, `homeYaw`). The recapture shows North America face-on with every pylon visible. | resolved |
| 5 | Macos-15 curves and dots are cut off at the right edge of the benchmark axes. | Not changed. SPEC § 4.4 sets each axis to the 1st to 99th percentile, with outliers clamped into the end bins, and the caption says the axes are zoomed. Widening the domain is a spec change. | unresolved |
| 6 | Rollouts: six full-height panels, and image versions dated after the survey ends. | Synthetic version names now derive from `--start` (`scripts/synthetic/generate.ts`); the new image is `20260125.2` for a survey starting 2026-01-05. Panel height unchanged. | partial |
| 7 | Overlapping labels: terrain beacons, sankey node labels at 375, centralus and northcentralus on the phone map. | Resolved after the review in two fix passes (Screenshot findings, below): terrain beacons as margin labels or spaced numbered markers with a numbered list, sankey names wrapped inside their column gap, region-map labels placed clear of every label and circle with leaders when displaced. | resolved |
| 8 | Every chart repeats "Data table" and the n and date-range caption. | Not changed. DESIGN § 6 requires each chart to state n and its range, because panels are read and shared one at a time. The disclosure is the accessible table. | unresolved |

The reviewer cited gate 58 (the screen budget, Floor) for the field log and gate 77 (the thin section, Reflex) for Methods. Neither gate applies to this page: both are in sloplint's `APP_SKIP` set for `--scope app` (`.claude/skills/hallmark/scripts/sloplint.mjs:798`), as are the other page-composition gates. Since no binding Floor gate was named and the first word was `fix`, not `rebuild`, there was no scoring round. Findings 2 and 3 are scored as craft findings.

The reviewer also wrote:

- **About:** an hourly, live survey of where GitHub's hosted runners run, how fast they are and how long jobs
  wait to start, read as a stack of charts.
- **Remembered:** the answer near the top and the weekday-by-hour heat strip.
- **Must not be diluted:** the answer-first top, and the slate and verdigris palette with its single copper
  for change points.
- **Gap:** from Fleet down, the page repeats one boxed panel, so it reads more as a report than a survey sheet.

Stamp record: `finish-review: subagent · 8 findings · 2 resolved 2 partial 4 unresolved · gap: …`
(`site/src/styles/tokens.css`, line 4).

## Screenshot findings

All 47 PNGs in `audit/screenshots/` were regenerated after the second fix pass (`npm run audit:screenshots`:
"wrote 47 screenshots, 47 PNGs in audit/screenshots, 0 external requests") and read again. Tall pages were read as contact
sheets of side-by-side strips, with full-resolution crops wherever text detail mattered.

| Shot | Finding | Action |
| --- | --- | --- |
| `day-{0,1,3,7,14,30,90}-1280-light`, `day-90-1280-dark` (fold) | Headline, sentence, answer, primary action and Methods link inside 1280 x 800 on every day. Title block and region map (or its locked state) to the right. Synthetic notice present. | pass |
| `day-0-*` | Standby: the next sweep time and "How runners are measured". The survey plate is drawn through its mask, in ink-2 on light and ivory on dark. Field log reads "No entries yet." | pass, after the 49b fix |
| `day-0-375-*` | Day-0 region map showed "Charting in progress" beside the standby panel, which said the same thing twice. | fixed: on a phone the locked hero map well is hidden; the title block and standby panel carry the state (`site/src/styles/shell.css:196`). Checked on the committed Day-0 at 375 (no "Charting in progress" visible) and at 1280 x 800 with and without JavaScript (headline, answer, primary action and map well in the fold). |
| `day-1-*`, `day-3-*` | Day-1 tier open. Later panels show "Charting in progress", what they need, the expected date and two progress bars. The hero says "No slot can be ranked yet: fewer than 3 survey days." | pass |
| `day-7-*`, `day-14-*`, `day-30-*` | Each tier opens on its day. Ranked slots carry "preliminary", "emerging" and "established". | pass |
| `day-90-1440-light`, `-dark` | Every tier open. The wide fleet and recent-samples tables fit without scrolling. Dark theme contrast reads cleanly. | pass |
| `day-90-*` (change points) | Caption showed the raw key `mann-whitney-u`. | fixed: "Mann-Whitney U test, false discovery rate 5%, shifts of at least 3%" (`site/src/charts/changepoints.ts:27`) |
| `day-90-*` (field log) | 90 entries took about 16,000 px of the 375 px page. Labels broke as "ubuntu-/24.04". Change points showed `singleCoreScore`. | fixed: latest 7 shown, older in a disclosure, labels `nowrap`, display names (`site/vite.config.ts`, `aggregator/src/fieldlog.ts`) |
| `day-90-375-*` (title block) | The range broke inside an ISO date. | fixed: each date in a `nowrap` span, breaking only at "to" |
| `day-90-375-*` (Methods) | Field-log lines ran past the reading measure at 1440. | fixed: `.field-log__list { max-width: 80ch }` |
| `day-90-375-*` (sankey) | Node labels truncated ("Apple …", "Neoverse…"), and "Neoverse…" runs into "westus2". | fixed: region names sit in a right margin sized to the longest name; every other name wraps inside its column gap and is pushed down past its neighbours; only a single word longer than the gap would take an ellipsis, and none does at 375 (`site/src/charts/fleet-sankey.ts:11`, `:46`, `:94`). Second pass: a name breaks before an opening bracket, so "Apple M1 / (Virtual)" no longer leaves a lone "(" at a line end (`:12`). Checked at 375 light and dark. |
| `day-90-375-*` (region map) | centralus and northcentralus labels collide, and eastus and eastus2 overlap at every width. | fixed: labels are placed largest region first, clear of every placed label and every circle except their own, with a hairline leader when displaced (`site/src/charts/region-map.ts:22`, `site/src/lib/labels.ts`). Second pass: a displaced label's near edge, not its centre, sits out from the circle, so a long name such as canadacentral no longer lies back over its own circle (`site/src/charts/region-map.ts:36`). A DOM probe at 375, 1280 and 1440 in both themes, on the hero map and on the globe's no-WebGL 2D fallback, found 7 of 7 names drawn, no two text boxes intersecting and none outside the SVG. The SVG holds no `id` attributes. |
| `day-90-3d-terrain` | Six beacon labels stacked, and their leader lines crossed. | fixed: labels sit in the stage margins with straight leaders when that layout breaks no rule (`site/src/lib/labels.ts:114`); otherwise each beacon shows its number and a numbered list under the stage gives the words, in the same order (`site/src/scenes/terrain.ts:174`, `:216`; `site/src/styles/scenes.css:63`, `:81`). Second pass: markers 4 and 6 (and 1 and 3) sat 1 to 3 px apart at 1280; markers now keep 3 px clearance, are placed by a pure, unit-tested `spreadMarkers` (`site/src/scenes/_common.ts:299`; `tests/unit/scenes.test.ts:74`). |
| `day-90-3d-pointcloud` | The "write MB/s" label looked cut off at the top, with a sliver of the synthetic notice over the stage. | fixed. The label is 40 px inside the stage in the DOM at every width. The cut was the sticky title strip (110 px at 1280, 139 px at 375 with the notice) covering a scene scrolled to `block: 'center'`, and the old `[id] { scroll-margin-top: 120px }` was also shorter than the 139 px phone strip. Site: `main.ts` measures the strip into `--strip-h` (`site/src/main.ts:38`) and `html { scroll-padding-top }` clears it for anchor jumps, focus and `scrollIntoView` (`site/src/styles/base.css:38`); `#methods` now lands at 151 px under a 139 px strip on a phone. Capture: the 3D shots use a 1280 x 1100 viewport, scroll with `block: 'start'`, and fail if the scene's top is under the strip or its bottom past the viewport (`scripts/audit/screenshots.ts:231`). |
| `day-90-3d-globe` | Faced Africa, with the pylons side-on. | fixed: home yaw on the regions |
| `day-90-1280-light-nowebgl` | Each 3D panel shows its 2D chart. The e2e test confirms each fallback is announced. | pass |
| `day-90-methods` | Statistics copy names the real methods: cluster bootstrap, the S score, Mann-Whitney U with Bonferroni and Benjamini-Hochberg, the 3% minimum shift. Data downloads names `data/raw/` and `schemas/`. | pass, after copy fixes |
| Probe: an opened "Data table" (region map) at 1440 light and 375 dark | The table renders under the chart in both themes and scrolls inside its region. The page `scrollWidth` equals the viewport (1440, 375). | pass |

## M7 asset checklist (DESIGN § 9)

| # | Item | emblem, glyphs | favicons, icons | og-card | graticule plate | contour plate | survey plate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Colours | `currentColor` only | paper `#f3f0e7` and ink `#1a2834` plus their antialiased blends | paper, ink, ink-2 `#33424f`, rule `#cbc7bd` plus blends | `currentColor`/token via mask | alpha-only, 1 RGB value in use | alpha-only, 1 RGB value in use |
| 2 | Texture | flat strokes | flat | flat fills and hairlines | lines | lines, no speckle | lines, no speckle |
| 3 | Subject | graticule quarter-globe, contour, triangle; sheet glyphs | the emblem | land outline and graticule | graticule and land | contours of Mount Rainier (USGS 3DEP) | land, graticule, triangulation of region points |
| 4 | Text | none | none | "Runner Atlas" in Hepta Slab and the hero sentence in Public Sans, as DESIGN § 5 | none | none | none |
| 5 | Figures | none | none | no numbers or dates | none | none | none |
| 6 | Geometry source | drawn geometry | from the emblem | world-atlas / Natural Earth | world-atlas / Natural Earth | USGS 3DEP tile n47w122, named in `NOTICE` | world-atlas and `aggregator/data/region-coords.json`, named in `NOTICE` |
| 7 | Size | 250 to 582 B each | favicon-32 860 B (≤ 4 KB); apple-touch 4,518 B; icon-512 11,190 B (≤ 40 KB) | 102,535 B, 1200 x 630 (≤ 300 KB) | 94,648 B (≤ 150 KB) | 135,132 B, 1200 x 800 (≤ 150 KB, ≤ 2400 wide) | 115,822 B, 1600 x 800 (≤ 150 KB) |
| 8 | Use on the page | emblem through a CSS mask on an `aria-hidden` span. All seven glyphs, including `glyph-methods` (placed in M11), on `aria-hidden` spans beside sheet titles | favicon links and the web manifest in the prerendered head | `og:image` | `plate-map`, `aria-hidden`, behind the title block | `plate-map`, `aria-hidden`, behind locked panels | Day-0 standby, `role="img"` with an `aria-label`, and a caption naming it a map of the regions the survey can place |
| 9 | Themes | `currentColor`, checked light and dark | fixed light rasters (allowed) | light only (allowed) | recolours by token | recolours by token | ink-2 on light, ivory on dark (Day-0 shots) |

The pages that use these assets pass sloplint at 0 FAIL on the static and render tiers.
`scripts/assets/check-plates-and-emblem.ts` exits 0: Delaunay edges, plate ink and holes, and
reproducible bytes. No `<img>` elements are used, because every asset is a CSS mask or a head link.
Assets total 512 KB, inside the 1 MB budget.

## Fixes applied in this audit

Label fix loops (after the review; code-reviewed and visually re-checked in a final independent pass):

- `site/src/lib/labels.ts` (new): pure placement geometry: overlap, leader hits and crossings, `firstClear`,
  `columnLayout`.
- `site/src/charts/fleet-sankey.ts:11`: wrapped node names in a sized region margin; break before "(".
- `site/src/charts/region-map.ts:22`: candidate spots with leaders, labels clear of labels and circles; displaced
  boxes pushed out by their own half-size (`:36`).
- `site/src/scenes/_common.ts`: `declutter` on the shared placer with leaders (`:252`); `spreadMarkers` with 3 px
  clearance (`:299`); `placeBeacons` (`:325`).
- `site/src/scenes/terrain.ts:174`: beacon markers and the numbered list. Probe: two "Show 2D chart" round trips
  leave exactly 1 list, 6 markers, 6 leaders and 1 canvas (the 2D view has none), and a 1280 → 375 resize
  re-spreads all 6 markers inside the 293 x 260 stage.
- `site/src/styles/scenes.css:63`, `:81`: marker and list styles, tokens only.
- `site/src/styles/shell.css:196`: locked hero map well hidden on a phone.
- `site/src/styles/base.css:38` and `site/src/main.ts:38`: scroll padding that tracks the sticky strip.
- `scripts/audit/screenshots.ts:231`: 3D captures clear of the sticky strip, asserted.
- `tests/unit/scenes.test.ts`: declutter never overlaps; six clustered beacons lay out with no overlap, meeting
  leaders or leader through a label, and a phone stage refuses the columns; markers keep their clearance.

Site:

- `site/src/charts/_axis.ts`: summary tables moved into a closed "Data table" disclosure.
- `site/src/charts/changepoints.ts:27`: plain-language method caption.
- `site/src/styles/charts.css`: `.chart__data` disclosure styles; closed table `display: none`.
- `site/src/styles/base.css`: removed the `.sr-only table` width rule.
- `site/src/styles/shell.css`:
  - field-log measure, `nowrap` labels and the older-entries disclosure;
  - title-block date `nowrap`;
  - methods heading glyph;
  - answer figures and the answer type step;
  - phone headline size.
- `site/src/styles/tokens.css`: the F25 answer and the review outcome lines in the stamp.
- `site/index.html`:
  - four panels made wide;
  - Methods statistics and data-download copy;
  - shorter standby link;
  - `glyph-methods` placed.
- `site/vite.config.ts`:
  - slot answers prerendered with figure spans, monospace on the digits only;
  - field log limited to 7 days with a disclosure, and labels kept whole;
  - title-block dates kept whole;
  - repository link defaults from `GITHUB_REPOSITORY`;
  - preview server serves `site/dist/data/rollups`.
- `site/src/scenes/globe.ts`: home yaw on the sampled regions.

Data and tooling:

- `aggregator/src/fieldlog.ts`: change-point sentences use display names.
- `scripts/synthetic/generate.ts`: image versions derived from `--start`.
- `scripts/audit/screenshots.ts`:
  - days 0, 1, 3, 7, 14, 30 and 90 (47 files);
  - the request guard is awaited before navigation.
- `tests/e2e/atlas.spec.ts`:
  - box-level overflow scanner with a positive control;
  - no-WebGL test records every announcement and checks each scene's 2D chart;
  - axe tests assert the theme before analysing;
  - the reduced-motion test checks that a link's computed transition is `0s` and that the same link has a
    non-zero transition without the preference. The old check counted CSS animations, and the site has
    none, so it passed either way.

Documentation:

- `SPEC.md`:
  - 4.8, display names;
  - 6.3, data-table disclosure;
  - 8, colour grep and gallery list.
- `DESIGN.md` § 5: the pinned first column.
- `DECISIONS.md`: D-024.

## Open findings

These are not Floor or Reflex findings, and sloplint does not flag them. Each needs a design decision rather
than an audit fix:

- the repeated boxed panel below Drift;
- the paired ridgeline and beeswarm panels;
- the six full-height rollout panels;
- eastus and eastus2 circles overlap on the map (their labels do not); the regions sit 0.7° of latitude and 1.4° of longitude apart;
- a scene taller than the space under the strip (the point cloud is 778 px at 1280) is centred by the browser on
  focus within the padded area, so on an 800 px-tall window its top 38 px sit under the strip and the "write MB/s" label clears the strip by
  about 2 px. Anchor jumps and `scrollIntoView` land clear.

## Verdict

**Pass.** The five label and capture defects left by the first review are fixed and checked by DOM probe and
screenshot in both themes. Sloplint has 0 FAIL and 0 REFLEX on the static tier, on the render tier for Day-0 and Day-90, and
on the hero stage. The one Finish item, F25, is answered with evidence, and there are no waivers. Both
reviews ran in fresh context. Every finding is scored, and each unresolved one says why. The
asset checklist passes on all nine items for every asset.
