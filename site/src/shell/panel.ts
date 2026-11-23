// One panel: owns its four states (loading, charting, error, full) and its render lifecycle.
import { loadRollup } from '../data.ts';
import { hasWebGL } from '../lib/webgl.ts';
import { readTokens, onTokensChange } from '../lib/tokens.ts';
import { el, replaceChildren } from '../lib/dom.ts';
import { formatCountCaption, formatRange, groupDigits, lockedMarkup } from '../lib/format.ts';
import type { Manifest } from '../../../shared/types/rollups.ts';
import type { Caption, ChartModule, PanelDef, RenderContext, SceneHandle, SceneModule } from '../types/views.ts';
import { announce } from './announce.ts';

type State = 'loading' | 'charting' | 'error' | 'full';
type Mod = ChartModule<never> | SceneModule<never>;

const MAX_ATTEMPTS = 2;

export class PanelView {
  private attempts = 0;
  private abort: AbortController | null = null;
  private scene: SceneHandle | null = null;
  private data: unknown = null;
  private mod: Mod | null = null;
  private sceneKind = false;
  private disposeTheme: (() => void) | null = null;
  private resizeFrame = 0;
  private errorAnnounced = false;
  private busy = false;
  private lastWidth = 0;
  private readonly body: HTMLElement;
  private chartRoot: HTMLElement;      // body, or a child of it while the user-chosen 2D view keeps its toggle below
  private swapping = false;
  private readonly caption: HTMLElement;

  private readonly section: HTMLElement;
  private readonly def: PanelDef;
  private readonly manifest: Manifest;

  constructor(section: HTMLElement, def: PanelDef, manifest: Manifest) {
    this.section = section;
    this.def = def;
    this.manifest = manifest;
    const body = section.querySelector<HTMLElement>('.panel-body');
    const caption = section.querySelector<HTMLElement>('.panel__caption');
    if (!body || !caption) throw new Error(`panel ${def.id} is missing its body or caption`);
    this.body = body;
    this.chartRoot = body;
    this.caption = caption;
    // Scenes dispatch this from their "Show 2D chart" button (scenes/_common.ts twoDToggle).
    body.addEventListener('scene:show-2d', () => void this.showTwoD());
  }

  // Shows the charting state when the tier is closed, or the lazily loaded chart when it is open.
  showStatus(): void {
    const status = this.manifest.tiers.find((t) => t.id === this.def.tier);
    if (!status || status.status === 'open') return;
    this.setState('charting');
    this.body.innerHTML = lockedMarkup({ ...status, samples: this.manifest.n.samples, surveyDay: this.manifest.surveyDay });
  }

  isOpen(): boolean {
    return this.manifest.tiers.find((t) => t.id === this.def.tier)?.status === 'open';
  }

  canAttempt(): boolean {
    return this.attempts < MAX_ATTEMPTS && this.section.dataset.state !== 'full';
  }

  async activate(): Promise<void> {
    if (this.busy || !this.isOpen() || !this.canAttempt()) return;
    this.busy = true;
    this.attempts += 1;
    this.setState('loading');
    this.body.replaceChildren();
    try {
      this.data = await loadRollup(this.def.rollup);
      if (this.def.kind === 'scene') await this.startScene();
      else {
        this.mod = (await this.def.load()).default as ChartModule<never>;
        this.renderChart();
      }
      this.setState('full');
      this.attempts = MAX_ATTEMPTS;
    } catch {
      this.showError();
    } finally {
      this.busy = false;
    }
  }

  // No WebGL, a failed scene import or a thrown mount all go to the 2D fallback; only a failed fallback is an error.
  private async startScene(): Promise<void> {
    if (!hasWebGL()) {
      await this.useFallback('WebGL is not available');
      return;
    }
    try {
      this.mod = (await this.def.load()).default;
      this.sceneKind = true;
      await this.mountScene();
    } catch {
      this.body.removeEventListener('webglcontextlost', this.onContextLost, { capture: true });
      this.scene?.dispose();
      this.scene = null;
      await this.useFallback('the 3D view could not start');
    }
  }

  private renderChart(): void {
    const mod = this.mod as ChartModule<never>;
    this.abort?.abort();
    this.abort = new AbortController();
    this.chartRoot.replaceChildren();
    const ctx = this.context(this.chartRoot, this.abort.signal);
    mod.render(ctx, this.data as never);
    this.renderCaption(mod.caption(this.data as never));
    this.lastWidth = this.body.clientWidth;
    this.watch();
  }

  private async mountScene(): Promise<void> {
    const mod = this.mod as SceneModule<never>;
    this.abort?.abort();
    this.abort = new AbortController();
    this.body.replaceChildren();
    const ctx = this.context(this.body, this.abort.signal);
    this.body.addEventListener('webglcontextlost', this.onContextLost, { capture: true, once: true });
    this.scene = await mod.mount(ctx, this.data as never);
    this.renderCaption(mod.caption(this.data as never));
    this.lastWidth = this.body.clientWidth;
    this.watch();
  }

  private readonly onContextLost = (): void => {
    this.abort?.abort();
    this.scene?.dispose();
    this.scene = null;
    this.useFallback('the 3D view lost its graphics context').then(() => this.setState('full'), () => this.showError());
  };

  private async useFallback(reason: string): Promise<void> {
    if (!this.def.fallback) throw new Error(`panel ${this.def.id} has no fallback`);
    this.mod = (await this.def.fallback()).default;
    this.sceneKind = false;
    this.chartRoot = this.body;
    this.renderChart();
    announce(`${this.def.title} shows its 2D chart because ${reason}.`);
  }

  // User chose the 2D chart: drop the scene, render the fallback with a pressed toggle below it that returns to 3D.
  private async showTwoD(): Promise<void> {
    if (!this.scene || this.swapping || !this.def.fallback) return;
    this.swapping = true;
    // Remove the listener first: dispose() forces a real context loss, which must not read as a failure.
    this.body.removeEventListener('webglcontextlost', this.onContextLost, { capture: true });
    this.abort?.abort();
    this.scene.dispose();
    this.scene = null;
    try {
      this.mod = (await this.def.fallback()).default;
      this.sceneKind = false;
      const toggle = el('button', { type: 'button', class: 'scene__button', 'aria-pressed': 'true' }, 'Show 2D chart');
      this.chartRoot = el('div', {});
      this.body.replaceChildren(this.chartRoot, el('div', { class: 'scene__controls' }, toggle));
      this.renderChart();
      toggle.addEventListener('click', () => void this.showThreeD(), { once: true });
      toggle.focus();
      announce(`${this.def.title} shows its 2D chart.`);
    } catch {
      this.showError();
    } finally {
      this.swapping = false;
    }
  }

  private async showThreeD(): Promise<void> {
    if (this.swapping) return;
    this.swapping = true;
    this.chartRoot = this.body;
    try {
      await this.startScene();
      if (this.scene) {
        this.body.querySelector<HTMLElement>('[data-show-2d]')?.focus();
        announce(`${this.def.title} shows its 3D view.`);
      }
    } catch {
      this.showError();
    } finally {
      this.swapping = false;
    }
  }

  private context(root: HTMLElement, signal: AbortSignal): RenderContext {
    return {
      root,
      tokens: readTokens(),
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      signal,
      width: root.clientWidth,
      announce,
    };
  }

  private renderCaption(c: Caption): void {
    const first = c.unit === 'runs'
      ? `n = ${groupDigits(c.n)} runs`
      : c.runs !== undefined ? formatCountCaption(c.n, c.runs) : `n = ${groupDigits(c.n)} samples`;
    const second = formatRange(c.range);
    replaceChildren(this.caption, el('span', {}, first), el('span', {}, second), c.note ? el('span', {}, c.note) : null);
  }

  // Re-renders on resize (width changed) and on theme change; scenes just get new tokens.
  private watch(): void {
    if (this.disposeTheme) return;
    const onTheme = (): void => {
      if (this.scene) this.scene.setTokens(readTokens());
      else if (!this.sceneKind && this.section.dataset.state === 'full') this.rerender();
    };
    this.disposeTheme = onTokensChange(onTheme);
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = requestAnimationFrame(() => {
        const width = this.body.clientWidth;
        if (width === this.lastWidth) return;
        this.lastWidth = width;
        if (this.scene) this.scene.resize(width, this.body.clientHeight);
        else if (!this.sceneKind && this.section.dataset.state === 'full') this.rerender();
      });
    });
    observer.observe(this.body);
  }

  // Theme and resize re-renders: a throw here lands in the error state, not in the console.
  private rerender(): void {
    try {
      this.renderChart();
    } catch {
      this.showError();
    }
  }

  private showError(): void {
    const file = this.def.rollup;
    this.abort?.abort();
    this.chartRoot = this.body;
    replaceChildren(
      this.body,
      el('p', { class: 'panel__error' },
        'This chart could not load. The data file is still available: ',
        el('a', { href: `data/rollups/${file}.json` }, `${file}.json`),
        '.'),
    );
    this.setState('error');
    if (!this.errorAnnounced) announce(`${this.def.title} could not load.`);
    this.errorAnnounced = true;
  }

  private setState(state: State): void {
    this.section.dataset.state = state;
  }
}
