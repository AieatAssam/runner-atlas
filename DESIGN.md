# Design: Runner Atlas

The locked visual system. Every Hallmark run and every frontend thread reads this first; pages share it. Change it on purpose, in this file, before changing CSS.

## 1. Identity and direction

**Idea:** a survey sheet that redraws itself every hour from the fleet it measures.

The look comes from survey cartography and field instruments: USGS topographic quadrangles (neatlines, title blocks, graticule ticks, contour isolines), ocean-survey bathymetry (depth as darker water), and slate-and-verdigris instrument panels. These are sources for structure and colour, never for ornament. No brass dials, gauges, knobs, bevels, engravings or paper grain (Hallmark `direction.md`, gates 47c and 80). Charts and cartographic plates are the only pictures, and every picture is real data, real geography or survey geometry (section 9).

What this is not: a SaaS dashboard of KPI cards, dark-purple glassmorphism, neon on near-black, a cream page with a clay accent and a high-contrast serif.

System summary:

- Genre: modern-minimal (developer infrastructure). Shape: app screen with a page hero.
- Theme: custom, vibe "survey cartography, field instruments, slate and verdigris".
- Axes: light/slab-serif/chromatic-teal (catalog check: clear). Posture: full-palette (six data series). Modes: light+dark.

## 2. Name and wordmark

- "Runner Atlas" is set in Hepta Slab 700, mixed case, roman, `--color-ink`, tracking -0.01em. It sits in the title strip at 1.2rem beside the emblem (20px), and nowhere larger. The headline, not the name, carries the hero.
- Edition and survey data are never an eyebrow over the headline. They live in the **title block**, a `<dl>` set beside the hero like a map's title block, framed by one neatline:
  - `Survey day` 12
  - `Samples` 3,141
  - `Range` 2026-11-23 to 2026-12-04
  - `Last sweep` `<time>`14:17 UTC`</time>`
- `<dt>` in Public Sans, 0.833rem, sentence case, untracked, `--color-muted`; `<dd>` figures in IBM Plex Mono, tabular.
- Forbidden: eyebrows, tracked uppercase, small caps, middle-dot meta strings, arrows glued to link text, decorative status dots, "Vol. / No." costume lines.

## 3. Palette

All UI tokens are OKLCH. Data tokens (`--chart-*`, `--seq-*`, `--div-*`) are hex, because D3 and Three.js read them as computed strings and neither parses `oklch()`. Hex values were computed from the OKLCH sources below.

```css
:root {
  color-scheme: light dark;
  /* Archival survey sheet */
  --color-paper:  oklch(95.5% 0.012 88);   /* #f3f0e7 rag paper, untextured */
  --color-paper-2: oklch(93% 0.014 88);    /* #ece8de panel wells */
  --color-paper-3: oklch(90% 0.016 86);    /* #e3ddd2 table stripes; never under charts */
  --color-ink:    oklch(27% 0.03 245);     /* #1a2834 slate ink */
  --color-ink-2:  oklch(37% 0.03 245);     /* #33424f */
  --color-muted:  oklch(49% 0.025 240);    /* #54636d labels, captions */
  --color-rule:   oklch(83% 0.014 85);     /* #cbc7bd hairlines, gridlines */
  --color-accent: oklch(47% 0.085 178);    /* #066a5b verdigris: primary action, current selection */
  --color-accent-ink: oklch(97.5% 0.008 88); /* #f9f7f1 text on accent */
  --color-focus:  oklch(48% 0.16 258);     /* #1659b5 cobalt focus ring */
  --color-warn:   oklch(50% 0.13 45);      /* #9d4616 oxidized copper: errors, anomalies */

  --chart-1: #0c60a3; /* cobalt      ubuntu-24.04 */
  --chart-2: #ad7300; /* ochre       windows-2025 */
  --chart-3: #0c7b60; /* verdigris   ubuntu-24.04-arm */
  --chart-4: #b64e10; /* copper      macos-15 */
  --chart-5: #a0557b; /* mauve       windows-11-arm */
  --chart-6: #545f68; /* slate       macos-15-intel, "other" */

  /* sequential: bathymetric, low delay pale, high delay deep */
  --seq-1: #d2eef0; --seq-2: #a8d8dd; --seq-3: #7cbdcd; --seq-4: #509dbe;
  --seq-5: #297cae; --seq-6: #125a98; --seq-7: #173c70;
  /* diverging: faster/earlier (cobalt) to slower/later (copper) */
  --div-low: #1666aa; --div-mid: #ebe8df; --div-high: #b64e10;
}

:root[data-theme="dark"] { /* Observatory slate */ }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* same block */ } }
```

Dark block ("Observatory slate"). The hue of every token stays the same as in light mode; lightness and chroma are re-derived:

```css
  --color-paper:  oklch(19% 0.016 245);    /* #0e151b deep slate, never #000 */
  --color-paper-2: oklch(22% 0.017 245);   /* #141c22 */
  --color-paper-3: oklch(25% 0.018 245);   /* #1a232a */
  --color-ink:    oklch(94% 0.015 88);     /* #efebe0 warm ivory */
  --color-ink-2:  oklch(84% 0.015 88);     /* #cecac0 */
  --color-muted:  oklch(72% 0.018 240);    /* #9ba6af */
  --color-rule:   oklch(34% 0.02 245);     /* #2f3942 */
  --color-accent: oklch(74% 0.08 178);     /* #70bcab */
  --color-accent-ink: oklch(19% 0.016 245);/* #0e151b */
  --color-focus:  oklch(76% 0.11 250);     /* #79b6f4 */
  --color-warn:   oklch(76% 0.12 45);      /* #f0986f */
  --chart-1: #6da9e7; --chart-2: #e6b55d; --chart-3: #70c1a5;
  --chart-4: #e99169; --chart-5: #d793b3; --chart-6: #8e9aa4;
  --seq-1: #192a3c; --seq-2: #1f405b; --seq-3: #1e5c7b; --seq-4: #247d97;
  --seq-5: #409ead; --seq-6: #6fc1c5; --seq-7: #a6e1e0;  /* high delay = brightest */
  --div-low: #6da9e7; --div-mid: #1a232a; --div-high: #e99169;
```

Dark also sets body weight 350 (Public Sans variable) and drops all shadows.

### Contrast (WCAG 2.x, computed)

| pair | light | dark | need |
| --- | --- | --- | --- |
Recomputed from the hex values above (sRGB relative luminance, 2026-11-22 review):

| pair | light | dark | need |
| --- | --- | --- | --- |
| ink / paper | 13.19 | 15.44 | 4.5 |
| ink-2 / paper | 9.07 | 11.24 | 4.5 |
| muted / paper, paper-2, paper-3 | 5.45, 5.07, 4.59 | 7.42, 6.95, 6.43 | 4.5 |
| accent-ink / accent | 6.09 | 8.29 | 4.5 |
| accent / paper (link text) | 5.72 | 8.29 | 4.5 |
| accent / paper-3 (progress fill on track) | 4.83 | 7.19 | 3.0 |
| focus / paper, paper-3 | 5.89, 4.96 | 8.59, 7.44 | 3.0 |
| warn / paper | 5.55 | 8.26 | 4.5 |
| chart-1..6 / paper (marks) | 5.73, 3.52, 4.59, 4.51, 4.52, 5.73 | 7.43, 9.75, 8.64, 7.64, 7.63, 6.40 | 3.0 |
| chart-1..6 / paper-2 | min 3.28 (chart-2) | min 6.00 (chart-6) | 3.0 |
| rule / paper | 1.48 | 1.56 | decorative only |

Rules: charts sit on `paper` or `paper-2`, never `paper-3` (ochre falls to 2.97). `--color-rule` is for hairlines, gridlines and neatlines only; it is never a form field's edge or a control's only boundary (gate 40 wants 3:1 there: field and control edges take `--color-muted`). Text never wears a series colour; series are named by a swatch beside an ink label. The six series follow Okabe-Ito hue families (blue, orange, bluish green, vermillion, reddish purple, grey) and stay distinguishable under protan, deutan and tritan simulation; still, no chart relies on hue alone (rows are labelled, legends toggle, points carry position).

Series assignment is fixed by label (above). Hardware families take `--chart-1..5` by descending sample count, the rest `--chart-6`. Accent is for the primary action, the current selection and focus state only (about 5% of a viewport).

## 4. Typography

| role | face | load |
| --- | --- | --- |
| display (headline, sheet titles, wordmark) | Hepta Slab, variable 100 to 900, used at 600/700 | `@fontsource-variable/hepta-slab` |
| body (prose, labels, captions, nav, table heads, buttons) | Public Sans, variable | `@fontsource-variable/public-sans` |
| figures (telemetry values, axis ticks, table numbers, title block values) | IBM Plex Mono 400/500 | `@fontsource/ibm-plex-mono` |

```css
--font-display: "Hepta Slab Variable", "Hepta Slab", ui-serif, "Rockwell", serif;
--font-body: "Public Sans Variable", "Public Sans", ui-sans-serif, "Segoe UI", sans-serif;
--font-figure: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
```

- Fonts are bundled from npm by Vite: no Google Fonts request, so offline Playwright audits render the real faces. If a variable package is missing at install, use the static `@fontsource/<name>` package and record it in DECISIONS. `font-display: swap`.
- Scale (ratio 1.2, rem at 16px): 0.833, 1, 1.2, 1.44, 1.728, 2.074, 2.488, 2.986. Hero headline 2.986rem/1.08 Hepta Slab 700, max 7 words. Sheet titles 2.074rem/1.15. Panel titles 1.44rem. Body 1rem/1.55, prose max 68ch. Labels and captions 0.833rem/1.4.
- Floor rules: labels, captions, table heads, tags and nav links are Public Sans, one step smaller, sentence or lower case, untracked. No uppercase transforms, no small caps, no letter-spacing above 0.01em. No single italic or coloured word in a heading. Heads are one weight and one colour. `font-variant-numeric: tabular-nums` on every numeric surface. Mono is for figures only (gate 64: figures and measurements).
- Display heads carry `overflow-wrap: break-word; min-width: 0`.

## 5. Layout, grid and fold

- Container: `max-width: 1280px; margin-inline: auto; padding-inline: clamp(16px, 4vw, 48px)`. At 1920 the gutters grow (320px each); measure and column counts do not change.
- Grid: 12 columns, `repeat(12, minmax(0, 1fr))`, gap `--space-5` (24px). Below 60rem, single column.
- `html, body { overflow-x: clip }`. No `100vw`. No `vh`; use `svh`/`dvh` if a height is ever needed.
- Spacing scale `--space-1..9`: 4, 8, 12, 16, 24, 32, 48, 72, 120 px. Every padding, margin and gap uses a token.
- **Hero at 1280 x 800, no scroll:** title strip (56px) then columns 1 to 7: headline, one sentence (max 12 words), the answer block, primary action plus the Methods link; columns 8 to 12: title block over the region map sheet (2:1). Sheets begin below the fold.
- Hero copy (fixed, real): headline "Where GitHub's hosted runners actually run"; sentence "An hourly survey of hardware, region, speed and start delay." Answer block examples: "Best observed slot: Tuesday 04:17 UTC, median wait 41 s (95% interval 32 to 55 s)." / "Worst: Monday 14:17 UTC, 3 min 10 s." / "Confidence: emerging, 9 days of sweeps." Day 0: "Awaiting first sweep. The next sweep starts at 15:17 UTC."
- Structure: no cards and no card inside a card. A sheet is a full-width ink hairline, a sheet head (title, the one-sentence question, caption on the right), then panels. A panel is framed once by a 1px `--color-rule` **neatline** with corner graticule ticks (four 6px strokes, CSS borders on pseudo-elements); nothing inside a panel is framed again. Tables are ruled (hairlines between rows, no zebra beyond `paper-2` header row).
- Radius: panels 0 (neatline), controls 4px. Shadows: none in either mode.
- Title strip: wordmark left; links "Survey", "Field log", "Methods"; theme switch; repository link. One row, sticky with `top: 0`. The only other sticky element is the first column of a ruled table, pinned at `left: 0` while the table scrolls inside its own focusable region (D-024).
- Colophon: data links (raw JSONL, rollups, schemas), repository, licence, last build time.

### Locked panel ("Charting in progress")

Same neatline frame, height of the panel it replaces (min 240px). Inside: title "Charting in progress", the sentence "{n} more samples and {d} more days needed.", "Expected on survey day 14, about 2026-12-06.", two labelled native `<progress>` bars (accent fill on `paper-3` track). Behind the text, at 0.12 opacity, the graticule plate (section 9), `aria-hidden`. No tick rows, no spinner, no blur.

### Loading and error panels

Hallmark's app-screen rule: every region that loads data has loading, empty, error and full states (SPEC 6.6). Loading is the panel's own neatline frame at its reserved height with title, question and caption already set, nothing animated. Empty is the locked panel above (or Day 0). Error keeps the frame and says, in body type: "This chart could not load. The data file is still available:" followed by a plain link to the rollup JSON; `--color-warn` only on a 2px rule at the top of the frame, never on the text.

## 6. Data viz rules

- Gridlines 1px solid `--color-rule`, 3 to 5 per axis. One y-axis. Bars <= 24px thick, start at zero, 2px end radius max. Lines 2px. Markers only on annotated points.
- Heatmap and terrain use `--seq-*` (7 steps; interpolate in Lab between them for continuous). Effects and z-scores use `--div-low/mid/high`.
- Every chart: title, the question it answers, caption with `n` and date range on two lines, an accessible summary.
- Tooltips: appear on hover after 800ms, on focus instantly; they repeat the cell's `n`.

### 3D scene look

Flat-shaded, ink lines, no glow, bloom, fog, gradients or reflective materials. Background `--color-paper-2`. Terrain: `--seq` vertex colours, ink contour isolines at 1px, beacons as 1px ink verticals with DOM labels. Point cloud: 3px points in series colours, axis lines in `--color-ink-2`. Globe: sphere in `--color-paper-2`, graticule in `--color-rule`, land outlines in `--color-ink-2`, pylons in `--seq` by delay. Controls under each scene: "Show 2D chart", "Pause motion" (globe), "Reset view", in Public Sans as secondary buttons.

## 7. Motion and interaction

- Durations `--dur-micro: 90ms`, `--dur-short: 160ms`; easing `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`.
- Transitions list properties: `color, background-color, border-color, opacity, transform`. Never `transition: all`; never animate `width`, `height`, `top`, `left`, `margin` or `padding`.
- `:focus-visible`: `outline: 2px solid var(--color-focus); outline-offset: 2px`, no transition. Every control has hover, focus-visible, active, disabled and current states.
- Controls 40px tall with a 44px hit area.
- `@media (prefers-reduced-motion: reduce)`: all transitions and animations end at once; 3D idle rotation off; camera moves instant.
- No reveal-on-scroll. Content is visible with scripting off.
- Browser surfaces themed: `::selection` (accent at 25% on ink), `caret-color: var(--color-accent)`, `scrollbar-color: var(--color-rule) var(--color-paper)`.

## 8. Copy rules

Plain verbs, sentence case, the product's own nouns (runner, label, sweep, slot, survey day). No em or en dashes in rendered copy, and no spaced double hyphen (`a -- b`), which sloplint gate 19 also reads as a dash: ranges read "2026-11-23 to 2026-12-04", "32 to 55 s". ISO dates keep their hyphens. Never in UI copy, alt text or `aria-label` (sloplint gate 19's full list): "unlock", "unleash", "seamless", "robust", "empower", "supercharge", "elevate", "effortless", "streamline", "revolutionize", "next-generation", "world-class", "best-in-class", "industry-leading", "mission-critical", "future-proof", "cutting-edge", "game-changer", "enterprise-grade", "quietly trusted", "built for the modern", "in today's"; no stock second action ("Learn more", "Get started", "Book a demo"); no "All rights reserved" in the colophon. DOM ids, classes and data attributes say `tier`, `opens` or `charting`, never `unlock`. Never an invented figure: every number comes from a rollup; synthetic builds show "Synthetic sample data, not measurements" in the title strip.

## 9. Visual assets (`site/assets/`, `site/public/`)

Codex CLI generates these in M7, following this section; a fresh Opus thread reviews them immediately in M7 against the checklist below before merging onto `main` (and M11 records the full asset checklist in `audit/hallmark-audit.md`). Codex may produce raster (PNG, WebP) and vector (SVG) files and may use an image model for drafts, but what ships must meet the checklist.

**What sloplint sees.** Its static tier reads only `.html`, `.css`, `.jsx`, `.tsx`, `.vue`, `.svelte` and `.astro`; it never opens an image file. It does lint how an asset is used: a decorative `<svg>` without `aria-hidden` (gate 33), a broken `<img>` (76), and, in the render tier, a large SVG figure not named as a map or chart (80). So the image files themselves pass or fail on the M11 checklist, and the markup that places them passes or fails on sloplint.

**Texture, defined.** Hallmark's custom direction refuses paper or grain as a surface, and imitation material (47c); this system keeps that refusal (D-019).

- Banned in any asset and in CSS: noise, grain, paper fibre, stains, halftone, vignettes, gradients, glow, bevels, engraving, brass, dials, gauges, compasses or any drawn instrument, and any raster tiled as a page or panel surface.
- Allowed, as **plates**: line art of survey geometry or real geography (graticules, contour isolines of a real landform, hachures, triangulation networks, coastlines). Raster plates are **alpha-only** (one ink on transparency, antialiased edges only) and are painted through CSS `mask-image` with `background-color: var(--color-rule)` or `var(--color-ink-2)`, so their colour is a token and they recolour with the theme. Opacity <= 0.12, only behind the title block, the Day 0 standby and locked panels, `aria-hidden="true"`, `pointer-events: none`, class `plate-map` (names it a map for gate 80).

| asset | path | format | brief |
| --- | --- | --- | --- |
| emblem | `site/assets/emblem.svg` | SVG, `currentColor`, no text | A quarter of a globe seen as graticule: two meridians and two parallels as 1.5px strokes inside a square neatline, one contour arc crossing them, a small solid triangulation triangle at the arc's crest. Legible at 20px, holds to 512px. Codex may draft it as a raster, then redraws it as geometry. Prompt draft: "minimal monoline cartographic mark, quarter-globe graticule in a square neatline, single contour line, small survey triangle, slate ink on flat light background, vector, no text, no gradients". |
| favicon set | `site/public/favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` (180), `icon-512.png`, `site.webmanifest` | SVG + PNG | Rasterized from the emblem. `favicon.svg` swaps ink and paper inside the SVG under `prefers-color-scheme`. PNGs: `--color-ink` mark on `--color-paper`; `icon-512.png` maskable with the mark inside the central 80% safe zone. |
| social card | `site/public/og-card.png` | PNG 1200 x 630, light only | `paper` ground; "Runner Atlas" in Hepta Slab 700 at 56px; the hero sentence in Public Sans; the equirectangular land outline and 15-degree graticule in `ink-2` and `rule` across the right 60%. No numbers, no dates (the card is static). Text is set from the bundled fonts by rendering `scripts/assets/og-card.html` with Playwright, never painted by an image model. |
| sheet glyphs | `site/assets/glyph-<sheet>.svg` | SVG, 24px grid, 1.5px stroke, round caps, `currentColor` | fleet: three stacked horizontal bars branching (a Sankey fork); benchmarks: three ridgeline curves; drift: a 3 x 3 grid with one filled cell; neighbours: scatter of five points and a fitted line; rollouts: a timeline with a vertical change marker; seasonality: a sine-like contour with a period bracket; methods: a plane table triangle. One set, one stroke weight. Set beside sheet titles at 24px, `aria-hidden`. |
| graticule plate | `site/assets/plate-graticule.svg` | SVG, deterministic | Written by `scripts/assets/plates.ts` with d3-geo: 15-degree graticule and land outline from `world-atlas`, equirectangular. |
| contour plate | `site/assets/plate-contours.webp` | alpha-only raster, <= 2400px wide | Contour isolines (and optional hachures) of one real landform from a public-domain elevation source named in `NOTICE`. Codex generates or traces it; never invented terrain. Live drift contours belong to the terrain scene, not to a static plate. |
| survey plate (illustrative artwork) | `site/assets/art-survey-plate.webp` | alpha-only raster, 1600 x 800, painted through `mask-image` like the plates but at full opacity in `--color-ink-2` | The one illustration: the world land outline with its graticule, and a triangulation network joining the region points in `aggregator/data/region-coords.json`, drawn as a survey sheet. Shown in the Day 0 standby only (`README.md` uses `og-card.png`, since GitHub cannot apply a mask), inside a `<figure>` with a `<figcaption>` that names it a map of the regions the survey can place. |

M11 acceptance checklist (record each item per asset in `audit/hallmark-audit.md`):

1. Colours: every opaque pixel is a token hex from section 3 or an antialiased blend of one token with transparency or `paper`; alpha-only plates have one colour channel in use. No gradient, glow or shadow.
2. Texture: at 400% zoom no speckle, grain or fibre; flat fills and lines only.
3. Subject: survey geometry or real geography only. No objects, instruments, people, buildings, landscapes in perspective, UI or browser frames, emoji, GitHub, Microsoft or Azure logos, or Octocat (gates 30a, 47a, 80; no borrowed brands).
4. Text: none except the wordmark (emblem has none) and, on `og-card.png`, the wordmark and hero sentence exactly as in section 5, in the real faces.
5. Figures: no numbers, dates or invented data anywhere (gate 46a).
6. Geometry source: coastlines from `world-atlas`/Natural Earth, elevation source named in `NOTICE`; generated assets listed in `NOTICE` as generated for this repo, under the repo licence.
7. Size and dimensions: exact pixel sizes above; `favicon-32.png` <= 4 KB, other icons <= 40 KB, `og-card.png` <= 300 KB, each plate and the survey plate <= 150 KB, `site/assets/` plus `site/public/` <= 1 MB in total.
8. Use: every `<img>` has `width`, `height` and `alt` (plates `alt=""` with `aria-hidden`), `loading="lazy"` unless it is the LCP element; decorative inline SVG carries `aria-hidden="true"`; sloplint static and render tiers stay at 0 FAIL on pages that use them.
9. Themes: masked plates and `currentColor` glyphs checked in light and dark screenshots; nothing is a fixed light-only raster except the favicon PNGs and `og-card.png`.

## 10. Hallmark stamp and Floor compliance

Line 1 of `site/src/styles/tokens.css` (canonical) and the first line of every other CSS file under `site/src/styles/` (`/* Hallmark · see tokens.css */`):

```css
/* Hallmark · v2.0.0 · theme: custom · idea: "a survey sheet that redraws itself every hour from the fleet it measures" · vibe: "survey cartography, field instruments, slate and verdigris" · shape: app screen · genre: modern-minimal · posture: full-palette (six data series, verdigris accent) · axes: light/slab-serif/chromatic-teal · modes: light+dark · faces: Hepta Slab, Public Sans, IBM Plex Mono · hero: answer beside the title block and map sheet · nav: title strip, wordmark, three links, theme switch · footer: colophon with data links · signature: the best and worst slot answer beside the live region map · states: loading, charting, error, full · job: read the answer · data: live */
/* Hallmark · pre-emit critique: P_ H_ E_ S_ R_ V_ · weakest: _, <fix taken> */
```

M8 fills the critique honestly before the first sweep. Waivers, answers and dismissals follow line 2, within the first 40 lines. CSS is linked from `site/index.html` with `<link rel="stylesheet">` so sloplint follows it.

Floor checklist, zero waivers:

1. Every colour and font through `:root`/theme tokens; TS reads tokens, never literals (grep gate).
2. No `transition: all`; no layout-property animation.
3. No single italic word in a roman head.
4. `overflow-x: clip` on `html` and `body`.
5. `minmax(0, 1fr)` tracks; display heads `overflow-wrap: break-word; min-width: 0`.
6. Instant `:focus-visible` on every interactive element, 3:1 ring.
7. Reduced-motion fallback for every animation; full content with scripting off (prerender).
8. No invented metric, testimonial, logo wall.
9. No eyebrow; no tracked caps or small-caps labels.
10. No middle-dot meta strings, glued arrows or status dots.
11. No purple-blue gradient, card in card, emoji icon or drawn browser window.
12. Hero headline, sentence, answer and primary action visible at 1280 x 800 (Playwright, since app scope skips 44b).
13. About 80 words in the hero screen.
14. Container capped at 1280 and centred.
15. Stamp on line 1, critique on line 2.
16. `sloplint` clean (SPEC section 8): 0 FAIL, every REFLEX fixed or waived with a reason.
