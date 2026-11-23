import '@fontsource-variable/hepta-slab';
import '@fontsource-variable/public-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/scenes.css';
import { loadManifest } from './data.ts';
import { panelById } from './panels.ts';
import { initRouter } from './router.ts';
import { initTheme } from './shell/theme.ts';
import { PanelView } from './shell/panel.ts';
import { formatSweepClock, nextSweep } from './lib/format.ts';
import type { Manifest } from '../../shared/types/rollups.ts';

// Day 0 only: the prerender says sweeps run at :17; the browser names the next one.
function showNextSweep(): void {
  const at = nextSweep(new Date());
  const node = document.getElementById('next-sweep');
  if (node) {
    node.textContent = formatSweepClock(at);
    node.setAttribute('datetime', at.toISOString());
    node.closest('p')?.removeAttribute('hidden');
  }
  const lead = document.getElementById('answer-lead');
  if (lead) lead.textContent = `Awaiting first sweep. The next sweep starts at ${formatSweepClock(at)}.`;
}

function applyDataState(manifest: Manifest): void {
  const sheets = document.getElementById('sheets');
  const standby = document.getElementById('standby');
  const synthetic = document.getElementById('synthetic-banner');
  const hasData = manifest.n.samples > 0;
  sheets?.toggleAttribute('hidden', !hasData);
  standby?.toggleAttribute('hidden', hasData);
  synthetic?.toggleAttribute('hidden', manifest.dataSource !== 'synthetic');
}

// The sticky title strip wraps (nav, synthetic notice), so its live height drives scroll-padding-top in base.css.
function trackStripHeight(): void {
  const strip = document.querySelector<HTMLElement>('.title-strip');
  if (!strip) return;
  new ResizeObserver(() => document.documentElement.style.setProperty('--strip-h', `${Math.ceil(strip.offsetHeight)}px`)).observe(strip);
}

async function boot(): Promise<void> {
  initTheme();
  trackStripHeight();
  initRouter();

  let manifest: Manifest;
  try {
    manifest = await loadManifest();
  } catch {
    // The prerendered text stays on screen; there is nothing to mount.
    return;
  }
  applyDataState(manifest);
  if (manifest.n.samples === 0) {
    showNextSweep();
    window.setInterval(showNextSweep, 60_000);
    return;
  }

  const views = new Map<HTMLElement, PanelView>();
  for (const section of document.querySelectorAll<HTMLElement>('section.panel[data-panel]')) {
    const def = panelById(section.dataset.panel ?? '');
    if (!def) continue;
    const view = new PanelView(section, def, manifest);
    view.showStatus();
    if (view.isOpen()) views.set(section, view);
  }

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const view = views.get(entry.target as HTMLElement);
      if (!view) continue;
      void view.activate().then(() => {
        if (!view.canAttempt()) io.unobserve(entry.target);
      });
    }
  }, { rootMargin: '400px 0px' });
  for (const section of views.keys()) io.observe(section);
}

void boot();
