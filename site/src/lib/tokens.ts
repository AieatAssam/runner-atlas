// Sole reader of the design tokens. UI tokens are OKLCH; chart tokens are already hex (DESIGN section 3, D-012).
import type { ChartTokens } from '../types/views.ts';

function read(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!value) throw new Error(`design token ${name} is not set`);
  return value;
}

let probe: CanvasRenderingContext2D | null = null;

// Converts any CSS colour the canvas accepts (oklch included) to #rrggbb by painting one pixel.
function toHex(color: string): string {
  if (!probe) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    probe = canvas.getContext('2d');
  }
  if (!probe) throw new Error('2D canvas unavailable for colour conversion');
  probe.fillStyle = 'transparent';
  const before = probe.fillStyle;
  probe.fillStyle = color;
  if (probe.fillStyle === before) throw new Error(`cannot parse colour ${color}`);
  probe.clearRect(0, 0, 1, 1);
  probe.fillRect(0, 0, 1, 1);
  const px = probe.getImageData(0, 0, 1, 1).data;
  return '#' + [px[0], px[1], px[2]].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('');
}

function ui(name: string): string {
  return toHex(read(name));
}

export function readTokens(): ChartTokens {
  return {
    paper: ui('--color-paper'),
    paper2: ui('--color-paper-2'),
    ink: ui('--color-ink'),
    ink2: ui('--color-ink-2'),
    muted: ui('--color-muted'),
    rule: ui('--color-rule'),
    accent: ui('--color-accent'),
    focus: ui('--color-focus'),
    warn: ui('--color-warn'),
    series: [read('--chart-1'), read('--chart-2'), read('--chart-3'), read('--chart-4'), read('--chart-5'), read('--chart-6')],
    sequential: [read('--seq-1'), read('--seq-2'), read('--seq-3'), read('--seq-4'), read('--seq-5'), read('--seq-6'), read('--seq-7')],
    diverging: { low: read('--div-low'), mid: read('--div-mid'), high: read('--div-high') },
    fontBody: read('--font-body'),
    fontFigure: read('--font-figure'),
  };
}

// Calls back when the theme attribute or the OS colour scheme changes. Returns an unsubscribe function.
export function onTokensChange(callback: () => void): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', callback);
  return () => {
    observer.disconnect();
    media.removeEventListener('change', callback);
  };
}
