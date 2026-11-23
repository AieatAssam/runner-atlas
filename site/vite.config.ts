import { defineConfig, type Plugin } from 'vite';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import type { Manifest } from '../shared/types/rollups.ts';
import {
  confidenceSentence, formatRange, formatSweepClock, groupDigits, lockedMarkup, slotSentence,
} from './src/lib/format.ts';

const siteDir = fileURLToPath(new URL('.', import.meta.url));
const rollupsDir = resolve(siteDir, '..', process.env.RUNNER_ATLAS_ROLLUPS_DIR || 'data/rollups');
const siteUrl = process.env.RUNNER_ATLAS_SITE_URL || 'http://127.0.0.1:4173/';
const outDir = resolve(siteDir, 'dist');

// Dev serves the source rollups; preview serves the copy inside dist, so it always matches the prerendered HTML.
function serveRollups(dir: string): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  return (req, res, next) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const prefix = '/data/rollups/';
    if (!path.startsWith(prefix)) return next();
    const file = resolve(dir, decodeURIComponent(path.slice(prefix.length)));
    if (!file.startsWith(dir + sep) || !existsSync(file)) return next();
    res.setHeader('content-type', 'application/json');
    res.end(readFileSync(file));
  };
}

function setById(html: string, id: string, inner: string): string {
  const pattern = new RegExp(`(<([a-z0-9]+)\\b[^>]*\\bid="${id}"[^>]*>)[\\s\\S]*?(</\\2>)`);
  return html.replace(pattern, (_all, open: string, _tag: string, close: string) => `${open}${inner}${close}`);
}

function setHidden(html: string, id: string, hidden: boolean): string {
  const pattern = new RegExp(`<([a-z0-9]+)\\b([^>]*)\\bid="${id}"([^>]*)>`);
  return html.replace(pattern, (tag: string) => {
    const stripped = tag.replace(/\s+hidden(?=[\s>])/, '');
    return hidden ? stripped.replace(/>$/, ' hidden>') : stripped;
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function prerender(html: string, m: Manifest): string {
  const hasData = m.n.samples > 0;
  const best = m.headline.best;
  const worst = m.headline.worst;
  let out = html;

  out = setById(out, 'td-survey-day', String(m.surveyDay));
  out = setById(out, 'td-samples', groupDigits(m.n.samples));
  out = setById(out, 'td-range', escapeHtml(formatRange(m.range)));
  out = setById(out, 'td-sweep', m.lastSampleIso
    ? `<time datetime="${escapeHtml(m.lastSampleIso)}">${formatSweepClock(new Date(m.lastSampleIso))}</time>`
    : 'Not yet');
  const entries = m.fieldLog.map((e) => `<li><span class="field-log__date">${escapeHtml(e.date)}</span> ${escapeHtml(e.text)}</li>`);
  out = setById(out, 'field-log-list', entries.length ? entries.join('') : '<li>No entries yet.</li>');

  const lead = best
    ? slotSentence('Best', best)
    : hasData
      ? `No slot can be ranked yet: ${m.headline.reason ?? 'not enough sweeps'}.`
      : 'Awaiting first sweep. Sweeps run hourly at 17 minutes past the hour, UTC.';
  out = setById(out, 'answer-lead', escapeHtml(lead));
  out = setById(out, 'answer-worst', worst ? escapeHtml(slotSentence('Worst', worst)) : '');
  out = setHidden(out, 'answer-worst', !worst);
  out = setById(out, 'answer-confidence', escapeHtml(confidenceSentence(m.headline.tier, m.surveyDay)));
  out = setHidden(out, 'answer-confidence', !best);

  out = setHidden(out, 'standby', hasData);
  out = setHidden(out, 'sheets', !hasData);
  out = setHidden(out, 'synthetic-banner', m.dataSource !== 'synthetic');
  if (m.dataSource === 'synthetic') out = setById(out, 'synthetic-banner', 'Synthetic sample data, not measurements.');

  for (const tier of m.tiers) {
    for (const id of panelsForTier[tier.id] ?? []) {
      const state = tier.status === 'charting' ? 'charting' : 'loading';
      if (state === 'charting') {
        out = out.replace(new RegExp(`(data-panel="${id}"[\\s\\S]*?)<!--locked-->`), (_all, head: string) =>
          `${head}${lockedMarkup({ ...tier, samples: m.n.samples, surveyDay: m.surveyDay })}`);
      }
      out = out.replace(new RegExp(`(<section[^>]*data-panel="${id}"[^>]*data-state=")[a-z]+"`), `$1${state}"`);
    }
  }
  return out;
}

// Runs with or without a manifest: build time, repository link, favicons and share tags.
function headAndFooter(html: string): string {
  const repo = process.env.RUNNER_ATLAS_REPO_URL;
  const out = setById(html, 'build-time', `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`)
    .replace('<!--repo-->', repo ? `<a href="${escapeHtml(repo)}">Repository</a>` : '')
    .replace('<!--repo-link-->', repo ? `<li><a href="${escapeHtml(repo)}">Repository</a></li>` : '');
  const head = [
    '<link rel="icon" href="./favicon.svg" type="image/svg+xml">',
    '<link rel="icon" href="./favicon-32.png" sizes="32x32" type="image/png">',
    '<link rel="apple-touch-icon" href="./apple-touch-icon.png">',
    '<link rel="manifest" href="./site.webmanifest">',
    '<meta property="og:title" content="Runner Atlas">',
    `<meta property="og:image" content="${escapeHtml(siteUrl)}og-card.png">`,
    `<meta property="og:url" content="${escapeHtml(siteUrl)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
  ];
  return out.replace('</head>', `${head.map((line) => `    ${line}\n`).join('')}  </head>`);
}

// Tier to the panels that open with it (SPEC section 5); mirrors the tier field in src/panels.ts, which Node cannot load (import.meta.glob).
const panelsForTier: Record<string, string[]> = {
  day1: ['fleet-sankey', 'fleet-table', 'recent-samples', 'globe', 'region-map'],
  day3: ['ridgelines', 'beeswarm', 'pointcloud'],
  day7: ['drift-heatmap', 'terrain', 'slot-ranking'],
  day14: ['neighbours-scatter', 'neighbours-multiples'],
  day30: ['rollout-timeline', 'changepoints'],
  day90: ['seasonality-bands', 'seasonality-effects'],
};

function siteShell(): Plugin {
  return {
    name: 'runner-atlas-site',
    configureServer(server) {
      server.middlewares.use(serveRollups(rollupsDir));
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveRollups(resolve(outDir, 'data', 'rollups')));
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const file = resolve(rollupsDir, 'manifest.json');
        const filled = existsSync(file) ? prerender(html, JSON.parse(readFileSync(file, 'utf8')) as Manifest) : html;
        return headAndFooter(filled);
      },
    },
    closeBundle() {
      if (existsSync(rollupsDir)) cpSync(rollupsDir, resolve(outDir, 'data', 'rollups'), { recursive: true });
    },
  };
}

export default defineConfig({
  root: siteDir,
  base: './',
  plugins: [siteShell()],
  build: {
    outDir,
    emptyOutDir: true,
    manifest: true,
  },
});

