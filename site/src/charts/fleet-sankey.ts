// Label -> CPU family -> region flow. Link colour follows the runner label the flow starts from.
import { sankey, sankeyLinkHorizontal } from 'd3-sankey';
import type { FleetRollup } from '../../../shared/types/rollups.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { chartWidth, chartWrap, count, emptyNote, headCaption, labelColor, summaryTable, svgEl, svgFor, svgText, tooltip } from './_axis.ts';

const CHAR_W = 6.7;
const LINE_H = 12;

// Breaks a name after spaces, dots, hyphens and closing brackets, and before an opening bracket, into lines of at most maxChars. A single token longer than that is cut with an ellipsis.
function wrapName(name: string, maxChars: number): string[] {
  const tokens = name.match(/\(?[^ .()-]+[ .)-]*|[ .()-]+/g) ?? [name];
  const lines: string[] = [];
  let line = '';
  for (const token of tokens) {
    if (line && (line + token).trimEnd().length > maxChars) {
      lines.push(line.trimEnd());
      line = '';
    }
    line += token;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.map((l) => (l.length > maxChars ? `${l.slice(0, Math.max(1, maxChars - 1))}…` : l));
}

interface Node { id: string; kind: string; name: string; x0?: number; x1?: number; y0?: number; y1?: number }
interface Link { source: string | Node; target: string | Node; value: number; width?: number }

function render(ctx: RenderContext, data: FleetRollup): void {
  const { tokens } = ctx;
  const width = chartWidth(ctx);
  const height = Math.min(420, Math.max(260, Math.round(width * 0.6)));
  const wrap = chartWrap(ctx);

  // The rollup is shared with the table panels, so the layout works on copies.
  const nodes: Node[] = data.sankey.nodes.map((n) => ({ ...n }));
  const links: Link[] = data.sankey.links.map((l) => ({ ...l }));

  if (links.length === 0) {
    svgFor(wrap, width, height, 'Fleet mix: no flows yet.');
    emptyNote(wrap, 'No runner flows yet. The mix appears once samples arrive.');
    summaryTable(wrap, 'Fleet mix', ['From', 'To', 'Samples'], []);
    return;
  }

  // Region names sit in a right margin sized to the longest one, so no name has to share a gap with another column's name.
  const longestRegion = Math.max(0, ...data.sankey.nodes.filter((n) => n.kind === 'region').map((n) => n.name.length));
  const marginRight = Math.ceil(longestRegion * CHAR_W) + 12;
  const graph = sankey<Node, Omit<Link, 'source' | 'target'>>()
    .nodeId((d) => d.id)
    .nodeWidth(12)
    .nodePadding(10)
    .extent([[1, 1], [width - marginRight, height - 1]])({ nodes, links: links as never });

  // Label flows wear their label's series. A CPU family fed by exactly one label passes that colour on to its
  // region flows; a family shared by labels cannot say which label reached which region, so those flows stay muted.
  const colourOf = new Map<string, string>();
  const feeders = new Map<string, Set<string>>();
  for (const link of graph.links) {
    const source = link.source as Node;
    const target = link.target as Node;
    if (source.kind !== 'label') continue;
    colourOf.set(source.id, labelColor(tokens, source.name));
    feeders.set(target.id, (feeders.get(target.id) ?? new Set()).add(source.name));
  }
  for (const [id, set] of feeders) if (set.size === 1) colourOf.set(id, labelColor(tokens, [...set][0] ?? null));

  const svg = svgFor(wrap, width, height, `Fleet mix: ${data.labels.length} labels, flowing through CPU families to regions.`);
  const linkPath = sankeyLinkHorizontal();
  for (const link of graph.links) {
    const source = link.source as Node;
    const target = link.target as Node;
    const colour = colourOf.get(source.id) ?? tokens.muted;
    const path = svgEl('path', {
      class: 'chart__mark',
      d: linkPath(link as never) ?? '',
      fill: 'none',
      stroke: colour,
      'stroke-opacity': 0.4,
      'stroke-width': Math.max(1, link.width ?? 1),
    });
    svg.append(path);
    tooltip(ctx, wrap, path, `${source.name} to ${target.name}: n = ${count(link.value)} samples`);
  }

  type Placed = Node & { x0: number; x1: number; y0: number; y1: number; value?: number };
  const placed = graph.nodes as unknown as Placed[];
  for (const n of placed) {
    const rect = svgEl('rect', { x: n.x0, y: n.y0, width: n.x1 - n.x0, height: Math.max(1, n.y1 - n.y0), fill: tokens.ink2 });
    svg.append(rect);
    tooltip(ctx, wrap, rect, `${n.name}: n = ${count(n.value ?? 0)} samples`);
  }

  // Every name starts just past its node and runs into the gap before the next column. A name too long for that gap
  // wraps onto lines; names in one column that still meet are pushed down. Nothing is cut short or drawn over another name.
  const columnsX = [...new Set(placed.map((n) => n.x0))].sort((a, b) => a - b);
  const byColumn = new Map<number, Array<{ n: Placed; lines: string[]; mid: number }>>();
  for (const n of placed) {
    const start = n.x1 + 6;
    const next = columnsX.find((x) => x > n.x0 + 0.5);
    const limit = next === undefined ? width - 2 : next - 6;
    const lines = wrapName(n.name, Math.max(4, Math.floor((limit - start) / CHAR_W)));
    const list = byColumn.get(n.x0) ?? [];
    list.push({ n, lines, mid: (n.y0 + n.y1) / 2 });
    byColumn.set(n.x0, list);
  }
  for (const column of byColumn.values()) {
    column.sort((a, b) => a.mid - b.mid);
    let floor = 2;
    for (const item of column) {
      const h = item.lines.length * LINE_H;
      const top = Math.min(Math.max(item.mid - h / 2, floor), height - 2 - h);
      floor = top + h + 2;
      item.lines.forEach((text, i) => {
        svgText(svg, item.n.x1 + 6, top + (i + 1) * LINE_H - 3, text, {
          fill: tokens.ink,
          class: 'chart__halo',
          'aria-hidden': 'true',
        });
      });
    }
  }

  summaryTable(wrap, 'Fleet mix flows', ['From', 'To', 'Samples'],
    graph.links.map((l) => [(l.source as Node).name, (l.target as Node).name, count(l.value)]));
}

export default {
  panel: 'fleet-sankey',
  caption: (data: FleetRollup) => headCaption(data),
  render,
} satisfies ChartModule<FleetRollup>;
