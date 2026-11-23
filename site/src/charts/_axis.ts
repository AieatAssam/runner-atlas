// Shared helpers for the 2D charts: SVG and table builders, the hover and focus tooltip, captions and labels.
// Not a panel: panels.ts never loads this file by panel id.
import type { Selection } from 'd3-selection';
import type { Head, MetricId } from '../../../shared/types/rollups.ts';
import { el } from '../lib/dom.ts';
import { groupDigits } from '../lib/format.ts';
import type { Caption, ChartTokens, RenderContext } from '../types/views.ts';

export type Sel = Selection<SVGGElement, unknown, null, undefined>;

const SVG_NS = 'http://www.w3.org/2000/svg';
const FALLBACK_WIDTH = 640;
const MIN_WIDTH = 280;
const HOVER_DELAY_MS = 800;
const TIP_OFFSET_PX = 12;

export const METRIC_NAMES: Record<MetricId | 'totalDelaySec', string> = {
  singleCoreScore: 'Single core score',
  multiCoreScore: 'Multi core score',
  seqWriteMBs: 'Sequential write',
  seqReadMBs: 'Sequential read',
  memBandwidthGBs: 'Memory bandwidth',
  netTtfbMs: 'Network time to first byte',
  netMbps: 'Network throughput index',
  totalDelaySec: 'Total start delay',
};

// Seasonality carries no units of its own; these match benchmarks.json metrics[].unit (aggregator/src/benchmarks.ts).
export const METRIC_UNITS: Record<MetricId | 'totalDelaySec', string> = {
  singleCoreScore: 'Mops/s', multiCoreScore: 'Mops/s', seqWriteMBs: 'MB/s', seqReadMBs: 'MB/s',
  memBandwidthGBs: 'GB/s', netTtfbMs: 'ms', netMbps: 'Mbit/s', totalDelaySec: 's',
};

export function metricName(id: string): string {
  return (METRIC_NAMES as Record<string, string>)[id] ?? id;
}

// Content width, floored so a 0-width probe (hidden or not yet laid out) still draws.
export function chartWidth(ctx: RenderContext): number {
  return ctx.width > 0 ? Math.max(MIN_WIDTH, Math.round(ctx.width)) : FALLBACK_WIDTH;
}

export function svgEl<T extends SVGElement = SVGElement>(tag: string, attrs: Record<string, string | number> = {}): T {
  const node = document.createElementNS(SVG_NS, tag) as T;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

export function svgText(parent: Element, x: number, y: number, text: string, attrs: Record<string, string | number> = {}): SVGTextElement {
  const node = svgEl<SVGTextElement>('text', { x, y, ...attrs });
  node.textContent = text;
  parent.append(node);
  return node;
}

// One block of a chart: a wrapper that owns its tooltip layer and its SVG(s) and tables.
export function chartWrap(ctx: RenderContext): HTMLElement {
  const wrap = el('div', { class: 'chart' });
  wrap.append(el('div', { class: 'chart__tip', hidden: '', 'aria-hidden': 'true' }));
  ctx.root.append(wrap);
  return wrap;
}

export function svgFor(wrap: HTMLElement, width: number, height: number, summary: string): SVGSVGElement {
  const svg = svgEl<SVGSVGElement>('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'group',
    'aria-label': summary,
    class: 'chart__svg',
  });
  wrap.append(svg);
  return svg;
}

type Mark = HTMLElement | SVGElement;
const wired = new WeakMap<HTMLElement, { stop: boolean }>();

function tipOf(target: EventTarget | null): Mark | null {
  // Duck-typed rather than instanceof Element, so it also holds for a window other than the global one.
  return (target as Element | null)?.closest?.<Mark>('[data-tip]') ?? null;
}

// Makes target a data mark: hover shows its tooltip after 800 ms, keyboard focus shows it at once.
// Each wrap is one tab stop (roving tabindex); arrow keys, Home and End walk its marks in document order.
// Listeners sit once on the wrap, so thousands of marks cost nothing extra; all of them stop on abort.
export function tooltip(ctx: RenderContext, wrap: HTMLElement, target: Mark, text: string): void {
  target.dataset.tip = text;
  target.classList.add('chart__mark');
  if (!target.hasAttribute('role')) target.setAttribute('role', 'img');
  if (!target.hasAttribute('aria-label')) target.setAttribute('aria-label', text);
  let state = wired.get(wrap);
  if (!state) {
    state = { stop: false };
    wired.set(wrap, state);
    wire(ctx, wrap);
  }
  target.setAttribute('tabindex', state.stop ? '-1' : '0');
  state.stop = true;
}

function wire(ctx: RenderContext, wrap: HTMLElement): void {
  const { signal } = ctx;
  const box = wrap.querySelector<HTMLElement>(':scope > .chart__tip');
  let timer = 0;
  let current: Mark | null = null;
  let px = 0;
  let py = 0;
  const hide = (): void => {
    window.clearTimeout(timer);
    current = null;
    if (box) box.hidden = true;
  };
  const show = (mark: Mark, x: number, y: number): void => {
    if (!box || signal.aborted) return;
    box.textContent = mark.dataset.tip ?? '';
    box.hidden = false;
    const r = wrap.getBoundingClientRect();
    let left = x - r.left + TIP_OFFSET_PX;
    // Keep the tip inside the chart: flip it to the left of the pointer near the right edge.
    if (left + box.offsetWidth > r.width) left = Math.max(0, x - r.left - TIP_OFFSET_PX - box.offsetWidth);
    box.style.left = `${left}px`;
    box.style.top = `${y - r.top + TIP_OFFSET_PX}px`;
  };
  wrap.addEventListener('pointerover', (event) => {
    const mark = tipOf(event.target);
    if (mark === current) return;
    hide();
    current = mark;
    px = event.clientX;
    py = event.clientY;
    if (mark) timer = window.setTimeout(() => show(mark, px, py), HOVER_DELAY_MS);
  }, { signal });
  wrap.addEventListener('pointermove', (event) => {
    px = event.clientX;
    py = event.clientY;
    if (current && box && !box.hidden) show(current, px, py);
  }, { signal });
  wrap.addEventListener('pointerout', (event) => {
    if (tipOf(event.relatedTarget) !== current) hide();
  }, { signal });
  wrap.addEventListener('focusin', (event) => {
    const mark = tipOf(event.target);
    if (!mark || mark !== event.target) return;
    for (const other of wrap.querySelectorAll('[data-tip][tabindex="0"]')) other.setAttribute('tabindex', '-1');
    mark.setAttribute('tabindex', '0');
    hide();
    current = mark;
    const r = mark.getBoundingClientRect();
    show(mark, r.left + r.width / 2, r.top + r.height / 2);
  }, { signal });
  wrap.addEventListener('focusout', hide, { signal });
  wrap.addEventListener('keydown', (event) => {
    const mark = tipOf(event.target);
    if (!mark || mark !== event.target) return;
    const marks = [...wrap.querySelectorAll<Mark>('[data-tip]')];
    const i = marks.indexOf(mark);
    const last = marks.length - 1;
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    marks[Math.max(0, Math.min(last, next))]?.focus();
  }, { signal });
  signal.addEventListener('abort', hide, { once: true });
}

function buildTable(className: string, caption: string, headers: string[], rows: string[][]): HTMLTableElement {
  return el('table', { class: className },
    el('caption', { class: 'sr-only' }, caption),
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { scope: 'col' }, h)))),
    el('tbody', {}, ...rows.map((row) => el('tr', {}, ...row.map((cell) => el('td', {}, cell))))),
  );
}

// A visible ruled table (fleet, changepoints). Wrapped so a narrow phone scrolls the table, not the page.
export function ruledTable(ctx: RenderContext, caption: string, headers: string[], rows: string[][]): void {
  const wrap = chartWrap(ctx);
  wrap.classList.add('table-wrap');
  // A narrow screen scrolls the table inside this region, so the region takes focus for keyboard scrolling.
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', `${caption}, scrollable table`);
  wrap.setAttribute('tabindex', '0');
  wrap.append(buildTable('ruled', caption, headers, rows.length ? rows : [['No rows yet', ...headers.slice(1).map(() => '')]]));
}

// The data table every chart carries alongside its marks, in a closed "Data table" disclosure under the chart.
// Closed, it adds one line; open, it is a ruled table that scrolls inside its own region on a phone.
// The marks stay named while it is closed: the SVG carries an aria-label summary and every mark its own label.
export function summaryTable(wrap: HTMLElement, caption: string, headers: string[], rows: string[][]): void {
  const region = el('div', { class: 'table-wrap', role: 'region', 'aria-label': `${caption}, scrollable table`, tabindex: '0' },
    buildTable('ruled', caption, headers, rows.length ? rows : [['No rows yet', ...headers.slice(1).map(() => '')]]));
  wrap.append(el('details', { class: 'chart__data' },
    el('summary', {}, 'Data table', el('span', { class: 'sr-only' }, `: ${caption}`)),
    region));
}

export function emptyNote(wrap: HTMLElement, text: string): void {
  wrap.append(el('p', { class: 'chart__empty' }, text));
}

export function headCaption(head: Head, note?: string): Caption {
  return { n: head.n.samples, unit: 'samples', runs: head.n.runs, range: head.range, note };
}

// Series colour is fixed by runner label (DESIGN section 3); an unknown label takes the slate "other" series.
const LABEL_SERIES: Record<string, number> = {
  'ubuntu-24.04': 0, 'windows-2025': 1, 'ubuntu-24.04-arm': 2, 'macos-15': 3, 'windows-11-arm': 4, 'macos-15-intel': 5,
};

export function labelColor(tokens: ChartTokens, label: string | null): string {
  return tokens.series[LABEL_SERIES[label ?? ''] ?? 5] ?? tokens.ink;
}

// About one tick per 80 px of axis, so labels never collide on a phone.
export function tickCount(px: number, max = 6): number {
  return Math.max(2, Math.min(max, Math.floor(px / 80)));
}

export const ZOOMED_NOTE = 'Value axes are zoomed to the data and do not start at zero';

export function count(n: number): string {
  return groupDigits(n);
}

export function pct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

export function fixed(value: number, digits = 1): string {
  return value.toFixed(digits);
}
