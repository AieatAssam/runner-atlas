# Third-party licences

Runner Atlas code is licensed under Apache-2.0 (see `LICENSE`). The components below keep their own licences. Full texts for vendored skills are in their directories; npm packages carry their own `LICENSE` files in `node_modules/` after `npm install`.

## Vendored agent skills (`.claude/skills/`)

| Skill | Licence | Copyright | Licence file | Upstream |
| --- | --- | --- | --- | --- |
| hallmark | MIT | Copyright (c) 2026 Hallmark contributors | `.claude/skills/hallmark/LICENSE` | https://github.com/Nutlope/hallmark (commit `04977e1`) |
| frontend-design | Apache-2.0 | No copyright line in the vendored `LICENSE.txt`; source is Anthropic's skills repository | `.claude/skills/frontend-design/LICENSE.txt` | https://github.com/anthropics/skills (commit `e4bb5d9`) |
| impeccable | Apache-2.0 | Copyright 2025 Paul Bakaus | `.claude/skills/impeccable/LICENSE` | https://github.com/pbakaus/impeccable (commit `b49177d`) |

Commits come from `skills-lock.json`. None of the three skill directories ships a separate NOTICE file.

## Bundled fonts (loaded from npm via Fontsource)

| Package | Version | Licence | Copyright |
| --- | --- | --- | --- |
| `@fontsource-variable/hepta-slab` | 5.3.0 | SIL OFL 1.1 | Copyright 2018 The Hepta Slab Project Authors |
| `@fontsource-variable/public-sans` | 5.3.0 | SIL OFL 1.1 | Copyright 2015 The Public Sans Project Authors |
| `@fontsource/ibm-plex-mono` | 5.3.0 | SIL OFL 1.1 | Copyright 2017 IBM Corp. |

## Bundled npm packages (production dependency tree)

Direct dependencies are listed first. Transitive packages are included because Vite bundles them into the site.

| Package | Version | Licence | Copyright | Direct |
| --- | --- | --- | --- | --- |
| `ajv` | 8.20.0 | MIT | Copyright (c) 2015-2021 Evgeny Poberezkin | yes |
| `d3-selection` | 3.0.1 | ISC | Copyright 2010-2026 Mike Bostock | yes |
| `d3-scale` | 4.0.3 | ISC | Copyright 2010-2026 Mike Bostock | yes |
| `d3-shape` | 3.2.1 | ISC | Copyright 2010-2026 Mike Bostock | yes |
| `d3-array` | 3.2.5 | ISC | Copyright 2010-2026 Mike Bostock | yes |
| `d3-axis` | 3.0.1 | ISC | Copyright 2010-2026 Mike Bostock | yes |
| `d3-geo` | 3.1.2 | ISC | Copyright 2010-2026 Mike Bostock | yes |
| `d3-contour` | 4.0.3 | ISC | Copyright 2012-2026 Mike Bostock | yes |
| `d3-interpolate` | 3.0.2 | ISC | Copyright 2010-2026 Mike Bostock | yes |
| `d3-sankey` | 0.12.3 | BSD-3-Clause | Copyright 2015, Mike Bostock | yes |
| `three` | 0.187.0 | MIT | Copyright © 2010-2026 three.js authors | yes |
| `topojson-client` | 3.1.0 | ISC | Copyright 2012-2019 Michael Bostock | yes |
| `world-atlas` | 2.0.2 | ISC | Copyright 2013-2019 Michael Bostock (map data: Natural Earth, public domain) | yes |
| `@fontsource-variable/hepta-slab` | 5.3.0 | OFL-1.1 | see fonts table | yes |
| `@fontsource-variable/public-sans` | 5.3.0 | OFL-1.1 | see fonts table | yes |
| `@fontsource/ibm-plex-mono` | 5.3.0 | OFL-1.1 | see fonts table | yes |
| `commander` | 2.20.3 | MIT | Copyright (c) 2011 TJ Holowaychuk | no (topojson-client) |
| `d3-color` | 3.1.1 | ISC | Copyright 2010-2026 Mike Bostock | no (d3-interpolate, d3-scale) |
| `d3-format` | 3.1.3 | ISC | Copyright 2010-2026 Mike Bostock | no (d3-scale, d3-axis) |
| `d3-path` | 3.1.1 | ISC | Copyright 2015-2026 Mike Bostock | no (d3-shape) |
| `d3-time` | 3.1.1 | ISC | Copyright 2010-2026 Mike Bostock | no (d3-scale) |
| `d3-time-format` | 4.1.1 | ISC | Copyright 2010-2026 Mike Bostock | no (d3-scale) |
| `internmap` | 2.0.3 | ISC | Copyright 2021 Mike Bostock | no (d3-array, d3-scale) |
| `d3-array` | 2.12.1 (nested under d3-sankey) | BSD-3-Clause | Copyright 2010-2020 Mike Bostock | no (d3-sankey) |
| `d3-path` | 1.0.9 (nested under d3-sankey) | BSD-3-Clause | Copyright 2015-2016 Mike Bostock | no (d3-sankey) |
| `d3-shape` | 1.3.7 (nested under d3-sankey) | BSD-3-Clause | Copyright 2010-2015 Mike Bostock | no (d3-sankey) |
| `internmap` | 1.0.1 (nested under d3-sankey) | ISC | Copyright 2021 Mike Bostock | no (d3-sankey) |
| `fast-uri` | 3.1.9 | BSD-3-Clause | Copyright (c) 2011-2021 Gary Court; Copyright (c) 2021-present The Fastify team | no (ajv) |
| `fast-deep-equal` | 3.1.3 | MIT | Copyright (c) 2017 Evgeny Poberezkin | no (ajv) |
| `json-schema-traverse` | 1.0.0 | MIT | Copyright (c) 2017 Evgeny Poberezkin | no (ajv) |
| `require-from-string` | 2.0.2 | MIT | Copyright (c) Vsevolod Strukchinsky | no (ajv) |

## Development dependencies (not shipped)

These packages build and test the project. None of them is bundled into the site or the collector, and
none is redistributed by this repository. They are listed for completeness, with `@types/*` packages (MIT)
omitted.

| Package | Version | Licence | Used for |
| --- | --- | --- | --- |
| `vite` | 8.3.8 | MIT | site build and preview |
| `typescript` | 7.0.2 | Apache-2.0 | type checking |
| `vitest` | 5.1.1 | MIT | unit and integration tests |
| `happy-dom` | 21.0.4 | MIT | the DOM for chart unit tests (`tests/unit/charts.test.ts`) |
| `@playwright/test`, `playwright` | 1.65.1 | Apache-2.0 | end-to-end tests and the screenshot gallery |
| `@axe-core/playwright` | 4.14.0 | MPL-2.0 | accessibility checks in the end-to-end tests |
| `axe-core` | 4.14.1 | MPL-2.0 | the rule engine behind `@axe-core/playwright` |

The two MPL-2.0 packages are used unmodified from npm at test time only. Their source is available from
npm and https://github.com/dequelabs/axe-core and https://github.com/dequelabs/axe-core-npm.
