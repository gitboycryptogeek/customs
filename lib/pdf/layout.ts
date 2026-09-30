// Reconstruct `pdftotext -layout` output from pdf.js text runs.
//
// The existing loaders (notably scripts/load-cet.ts) parse a fixed-column text
// grid with regexes tuned against poppler's output — "description, a run of 2+
// spaces, then the rate at the far right". Rather than rewrite five parsers, we
// reproduce that grid: items are bucketed into visual lines by their vertical
// position, then written into a character grid at the column their x-coordinate
// implies. The result is a drop-in replacement for `pdftotext -layout`.
//
// This is deliberately the *compatibility* layer. New parsers should prefer
// ./columns.ts, which reads real geometry instead of counting spaces.

import type { PdfPage, TextItem } from "./types";

/** One visual row of a page: items that share a baseline, left to right. */
export interface Line {
  /** Top edge of the row, in points from the top of the page. */
  y: number;
  items: TextItem[];
}

/**
 * Group a page's runs into visual lines.
 *
 * Two runs belong to the same line when their vertical centres are within a
 * fraction of the text height. Government tariff tables routinely draw a row's
 * cells at very slightly different baselines, so a pure equality test on y
 * shatters one row into three — hence the tolerance rather than a bucket key.
 */
export function toLines(page: PdfPage, tolerance = 0.5): Line[] {
  const items = page.items.filter((i) => i.str.trim().length > 0);
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Line[] = [];

  for (const item of sorted) {
    const centre = item.y + item.height / 2;
    const slack = Math.max(2, (item.height || item.fontSize || 10) * tolerance);
    const open = lines[lines.length - 1];
    if (open && Math.abs(centre - (open.y + heightOf(open) / 2)) <= slack) {
      open.items.push(item);
      open.y = Math.min(open.y, item.y);
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }

  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

function heightOf(line: Line): number {
  return Math.max(...line.items.map((i) => i.height || i.fontSize || 10));
}

/**
 * Median width of one character on this page, used as the grid pitch.
 *
 * Taken from the runs themselves rather than assumed, because the corpus mixes
 * 8pt tariff tables with 12pt statute prose and a fixed pitch would either
 * collapse columns in one or explode them in the other. Median, not mean, so a
 * single stretched heading doesn't drag the whole grid.
 */
export function charWidth(page: PdfPage): number {
  const widths: number[] = [];
  for (const item of page.items) {
    const len = item.str.length;
    if (len >= 3 && item.width > 0) widths.push(item.width / len);
  }
  if (widths.length === 0) return 5;
  widths.sort((a, b) => a - b);
  const mid = widths[Math.floor(widths.length / 2)];
  // Guard against degenerate metrics in malformed PDFs.
  return mid > 0.5 && mid < 40 ? mid : 5;
}

/** A vertical band of whitespace running down a page — a table gutter. */
export interface Gutter {
  start: number;
  end: number;
}

/**
 * Find the vertical whitespace corridors on a page.
 *
 * Every run is projected onto the x-axis as an occupied span; a corridor is a
 * band where nothing is drawn on any line of the page. Real table gutters
 * produce corridors that run the full height, whereas the ragged right edge of
 * a prose paragraph does not — which is also how a table is told apart from a
 * page of text, so we never invent columns in prose.
 *
 * Shared with ./columns.ts so the layout grid and the column reader always
 * agree about where the columns are.
 */
export function detectGutters(
  page: PdfPage,
  lines: Line[],
  minGap?: number,
  /**
   * Fraction of rows allowed to bleed across a gutter and still leave it a
   * gutter. Not zero, because one long description overrunning its cell would
   * otherwise erase the column boundary for the entire page — which is what
   * hid 18 CET rows from the parser.
   */
  tolerance = 0.03
): Gutter[] {
  const width = Math.ceil(page.width) || 1;
  if (width <= 1 || lines.length === 0) return [];

  // Count ROWS that draw at each x, not runs: a row split into six cells must
  // not count six times against the gutter between two of them.
  const rowsAt = new Uint32Array(width + 2);
  const seen = new Uint8Array(width + 2);

  for (const line of lines) {
    seen.fill(0);
    for (const item of line.items) {
      if (!item.str.trim()) continue;
      const from = Math.max(0, Math.floor(item.x));
      const to = Math.min(width, Math.ceil(item.x + item.width));
      for (let x = from; x <= to; x++) seen[x] = 1;
    }
    for (let x = 0; x <= width; x++) if (seen[x]) rowsAt[x]++;
  }

  // A gutter must be wider than the space between two words, or every gap
  // between words becomes a column boundary.
  const gap = minGap ?? Math.max(4, medianCharWidth(lines) * 2);
  const allowed = Math.floor(lines.length * tolerance);

  const out: Gutter[] = [];
  let runStart = -1;
  for (let x = 0; x <= width; x++) {
    if (rowsAt[x] <= allowed) {
      if (runStart === -1) runStart = x;
    } else if (runStart !== -1) {
      if (x - runStart >= gap) out.push({ start: runStart, end: x });
      runStart = -1;
    }
  }
  if (runStart !== -1 && width - runStart >= gap) out.push({ start: runStart, end: width });
  return out;
}

/** Median width of one character across these lines. */
export function medianCharWidth(lines: Line[]): number {
  const widths: number[] = [];
  for (const line of lines) {
    for (const item of line.items) {
      const len = item.str.length;
      if (len >= 3 && item.width > 0) widths.push(item.width / len);
    }
  }
  if (widths.length === 0) return 5;
  widths.sort((a, b) => a - b);
  return widths[Math.floor(widths.length / 2)] || 5;
}

/** Which side of the page's gutters this x falls on — a coarse column index. */
function bandAt(x: number, gutters: Gutter[]): number {
  let band = 0;
  for (const g of gutters) {
    if (x >= g.end) band++;
    else break;
  }
  return band;
}

/**
 * Render one page as a column-aligned character grid — the `-layout` equivalent.
 *
 * Each run is written at the column its x-coordinate maps to. Where a long cell
 * overruns the next column's start, absolute positioning is no longer available
 * and we fall back to the page's real gutters: two runs on opposite sides of one
 * always get at least two spaces between them.
 *
 * That rule matters more than it looks. Every parser downstream distinguishes a
 * column boundary from a word space by counting spaces, so collapsing a gutter
 * to a single space silently drops a tariff row — which is exactly what it did
 * to 40 rows of the CET before this was added.
 */
export function layoutPage(page: PdfPage): string {
  const lines = toLines(page);
  if (lines.length === 0) return "";
  const pitch = charWidth(page);
  const gutters = detectGutters(page, lines);

  return lines
    .map((line) => {
      let out = "";
      let prevRight = 0;
      let prevBand = -1;

      for (const item of line.items) {
        const col = Math.max(0, Math.round(item.x / pitch));
        const band = gutters.length ? bandAt(item.x + item.width / 2, gutters) : -1;

        if (out.length === 0) {
          out = " ".repeat(col);
        } else {
          // How much white space this run's geometry demands: two spaces for a
          // column gutter, one for an ordinary word space.
          const crossedGutter = band !== -1 && prevBand !== -1 && band !== prevBand;
          const gapCols = (item.x - prevRight) / pitch;
          const separator = crossedGutter || gapCols >= 1.5 ? 2 : gapCols > 0.2 ? 1 : 0;

          // Take whichever puts the run further right: its true column, or the
          // minimum separation. Honouring only the column is what collapsed a
          // gutter to a single space whenever a long description had already
          // run past that column — and a one-space gutter reads as a word
          // space, so the row was dropped.
          const start = Math.max(col, out.length + separator);
          out += " ".repeat(start - out.length);
        }

        out += item.str;
        prevRight = item.x + item.width;
        prevBand = band;
      }
      return out.replace(/\s+$/, "");
    })
    .join("\n");
}

/** Every page as layout text, index+1 = the physical page number. */
export function layoutPages(pages: PdfPage[]): string[] {
  return pages.map(layoutPage);
}

/**
 * A line that starts a new provision: "7.", "(2)", "(a)", "(ba)", "12A.".
 *
 * Legislation is the corpus here, and it is enumerated rather than spaced —
 * subsections often follow one another at ordinary line spacing, so splitting
 * on vertical gaps alone merges a whole section into one block. Since a chunk
 * is what a search returns as its snippet, that is the difference between
 * finding a provision and being handed a page.
 */
const ENUMERATOR = /^\s*(\(\s*[0-9]{1,3}\s*\)|\([a-z]{1,3}\)|\([ivxl]{1,5}\)|[0-9]{1,3}[A-Z]?\.)\s+\S/;

/**
 * Prose reflow: paragraphs rather than a column grid.
 *
 * For statutes and circulars the column grid is noise — what a reader (and the
 * chunker) wants is provisions. A new one starts at a vertical gap wider than
 * the document's normal line spacing, or at an enumerator.
 */
export function paragraphsPage(page: PdfPage): string[] {
  const lines = toLines(page);
  if (lines.length === 0) return [];

  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i].y - lines[i - 1].y);
  const normal = median(gaps.filter((g) => g > 0)) || 12;

  const paras: string[] = [];
  let current: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;

    const gapBreak = i > 0 && lines[i].y - lines[i - 1].y > normal * 1.5;
    const enumBreak = ENUMERATOR.test(text);
    if (current.length && (gapBreak || enumBreak)) {
      paras.push(current.join(" "));
      current = [];
    }
    current.push(text);
  }
  if (current.length) paras.push(current.join(" "));

  return paras.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
