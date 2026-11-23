// Small multiples: one cell per label and CPU family, with the same steal and z scales in every cell so they compare.
import { scaleLinear } from 'd3-scale';
import type { NeighboursRollup } from '../../../shared/types/rollups.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { chartWidth, chartWrap, count, emptyNote, fixed, headCaption, labelColor, summaryTable, svgEl, svgFor, svgText, tooltip } from './_axis.ts';

const CELL_H = 130;
const CELL_MIN_W = 220;
const GAP = 12;
const PAD = { top: 34, right: 8, bottom: 22, left: 8 };

function short(text: string): string {
  return text.length > 30 ? `${text.slice(0, 29)}...` : text;
}

function render(ctx: RenderContext, data: NeighboursRollup): void {
  const { tokens } = ctx;
  const width = chartWidth(ctx);
  const wrap = chartWrap(ctx);
  const groups = data.byHardware;
  const { steal, z, label, family, labels, families } = data.points;
  // Points carry label and family as indices; each cell keeps only the points that match its own pair.

  if (groups.length === 0) {
    emptyNote(wrap, 'No Linux label and CPU family has enough runs yet.');
    summaryTable(wrap, 'Steal by label and CPU family', ['Label', 'CPU family', 'Samples', 'Median steal', 'p90 steal', 'Spearman rho'], []);
    return;
  }

  const cols = Math.max(1, Math.floor((width + GAP) / (CELL_MIN_W + GAP)));
  const cellW = (width - GAP * (cols - 1)) / cols;
  const rowsN = Math.ceil(groups.length / cols);
  const height = rowsN * (CELL_H + GAP) - GAP;
  const svg = svgFor(wrap, width, height, `${groups.length} small multiples of CPU steal against z score, one per label and CPU family.`);

  const xMax = Math.max(1, ...steal);
  const zExt = [Math.min(-0.5, ...z), Math.max(0.5, ...z)];
  const rows: string[][] = [];

  groups.forEach((g, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const ox = col * (cellW + GAP);
    const oy = row * (CELL_H + GAP);
    const iw = cellW - PAD.left - PAD.right;
    const ih = CELL_H - PAD.top - PAD.bottom;
    const x = scaleLinear().domain([0, xMax]).range([ox + PAD.left, ox + PAD.left + iw]);
    const y = scaleLinear().domain(zExt).range([oy + PAD.top + ih, oy + PAD.top]);
    const colour = labelColor(tokens, g.label);
    const text = `${g.label}, ${short(g.cpuFamily ?? '')}: n = ${count(g.n)} samples, median steal ${fixed(g.stealMedian, 2)}%` +
      (g.rho === null ? ', rho not computed' : `, Spearman rho ${fixed(g.rho, 2)}`);

    const cell = svgEl('g');
    cell.append(svgEl('rect', { x: ox, y: oy, width: cellW, height: CELL_H, fill: 'none', stroke: tokens.rule, 'stroke-width': 1 }));
    svgText(cell, ox + PAD.left, oy + 16, g.label, { fill: tokens.ink, 'font-weight': 600 });
    svgText(cell, ox + PAD.left, oy + 28, short(g.cpuFamily ?? ''), { fill: tokens.muted });
    svgText(cell, ox + cellW - PAD.right, oy + 16, g.rho === null ? 'rho n/a' : `rho ${fixed(g.rho, 2)}`, { 'text-anchor': 'end', fill: tokens.ink2 });
    svg.append(cell);

    for (let i = 0; i < steal.length; i++) {
      if (labels[label[i] ?? -1] !== g.label || families[family[i] ?? -1] !== g.cpuFamily) continue;
      svg.append(svgEl('circle', { cx: x(steal[i] ?? 0), cy: y(z[i] ?? 0), r: 1.6, fill: colour, 'fill-opacity': 0.55 }));
    }
    svg.append(svgEl('line', { x1: ox + PAD.left, x2: ox + PAD.left + iw, y1: y(0), y2: y(0), stroke: tokens.rule, 'stroke-width': 1 }));
    svgText(cell, ox + PAD.left, oy + CELL_H - 6, `steal 0 to ${fixed(xMax, 1)}%`, { fill: tokens.muted });
    tooltip(ctx, wrap, cell, text);
    rows.push([g.label, g.cpuFamily ?? '', count(g.n), `${fixed(g.stealMedian, 2)}%`, `${fixed(g.stealP90, 2)}%`, g.rho === null ? 'not computed' : fixed(g.rho, 2)]);
  });

  summaryTable(wrap, 'Steal by label and CPU family', ['Label', 'CPU family', 'Samples', 'Median steal', 'p90 steal', 'Spearman rho'], rows);
}

export default {
  panel: 'neighbours-multiples',
  caption: (data: NeighboursRollup) => headCaption(data, 'Linux runners only'),
  render,
} satisfies ChartModule<NeighboursRollup>;
