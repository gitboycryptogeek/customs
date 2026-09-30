// Generic table reading by geometry rather than by counting spaces.
//
// The existing CET parser works because someone sat with poppler's output and
// tuned a regex to that one document's column widths. That does not survive
// contact with 100 documents nobody has seen. This reads the columns the way a
// person does — by spotting the vertical white corridors that run down the page
// between them — so an unfamiliar tariff schedule can be read without anyone
// hand-tuning a pattern first.
//
// Everything here is deterministic: same page in, same grid out.

import { toLines, detectGutters } from "./layout";
import type { PdfPage } from "./types";

export interface Column {
  /** Left and right edges in PDF points. */
  start: number;
  end: number;
}

export interface GridRow {
  /** Top edge of the row, for ordering and for locating it on the page. */
  y: number;
  /** One entry per detected column, in left-to-right order. Empty cells are "". */
  cells: string[];
}

/**
 * Find column boundaries by locating vertical whitespace corridors.
 *
 * Every text run is projected onto the x-axis as an occupied span; a corridor is
 * a run of x where nothing is drawn on any line. Real table gutters produce
 * corridors that persist down the whole page, whereas the ragged right edge of a
 * prose paragraph does not — which is also how this tells a table from a page of
 * text and declines to invent columns in the latter.
 */
export function detectColumns(page: PdfPage, opts: { minGap?: number; minRows?: number } = {}): Column[] {
  const lines = toLines(page);
  const minRows = opts.minRows ?? 4;
  if (lines.length < minRows) return [];

  const width = Math.ceil(page.width) || 1;
  const corridors = detectGutters(page, lines, opts.minGap);

  // Turn the gutters into the columns between them, dropping the outer margins.
  const inner = corridors.filter((c) => c.start > 0 && c.end < width);
  if (inner.length === 0) return [];

  const cols: Column[] = [];
  let cursor = corridors[0]?.start === 0 ? corridors[0].end : 0;
  for (const gutter of inner) {
    if (gutter.start > cursor) cols.push({ start: cursor, end: gutter.start });
    cursor = gutter.end;
  }
  const rightMargin = corridors[corridors.length - 1];
  const pageEnd = rightMargin && rightMargin.end >= width ? rightMargin.start : width;
  if (pageEnd > cursor) cols.push({ start: cursor, end: pageEnd });

  return cols.length >= 2 ? cols : [];
}

/**
 * Read a page as rows of cells against the given columns.
 *
 * An item lands in the column its horizontal midpoint falls in — a cell whose
 * text slightly overhangs its gutter (common where a long description is set
 * tight) still reads correctly, whereas keying on the left edge alone would
 * push it into the neighbouring column.
 */
export function rowsFromColumns(page: PdfPage, columns: Column[]): GridRow[] {
  if (columns.length === 0) return [];
  return toLines(page).map((line) => {
    const cells: string[][] = columns.map(() => []);
    for (const item of line.items) {
      if (!item.str.trim()) continue;
      const mid = item.x + item.width / 2;
      const idx = columnIndexFor(mid, columns);
      if (idx >= 0) cells[idx].push(item.str);
    }
    return {
      y: line.y,
      cells: cells.map((parts) => parts.join(" ").replace(/\s+/g, " ").trim()),
    };
  });
}

function columnIndexFor(x: number, columns: Column[]): number {
  for (let i = 0; i < columns.length; i++) {
    if (x >= columns[i].start && x <= columns[i].end) return i;
  }
  // In a gutter: attach to the nearer column rather than dropping the text.
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < columns.length; i++) {
    const d = x < columns[i].start ? columns[i].start - x : x - columns[i].end;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
