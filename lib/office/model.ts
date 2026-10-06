// Word and spreadsheet documents, in the shape the rest of the pipeline reads.
//
// Everything downstream of extraction — the classifier, the chunker, the
// schedule, condition and amendment parsers — works off `PdfPage` geometry and
// per-page text. Rather than teach five consumers a second representation, an
// office document is cut into "parts" that play the role of pages, and each
// part is given synthetic geometry: table cells are laid out on a fixed-pitch
// grid with a real gutter between columns, so the column detector in
// lib/pdf/columns.ts finds exactly the columns the file declares. A spreadsheet
// is in fact the easiest table this system will ever read — its columns are not
// inferred from whitespace, they are given.
//
// A part is the unit a citation points at, so it has to be small enough to be
// useful: up to ROWS_PER_PART rows of one table, or one section of prose. The
// HTML view (./render.ts) gives every part an anchor named `page=N`, so the
// `#page=N` links every citation already carries land on the right part
// without the UI having to know what kind of file it is looking at.

import type { PdfPage, TextItem } from "../pdf/types";

/** Rows of a table per part. Small enough that a citation is a glance, not a scroll. */
export const ROWS_PER_PART = 50;

/** Prose characters per part before a new one is started even without a heading. */
const PROSE_PART_CHARS = 3000;

/** Synthetic geometry: points per character, per line, and the gutter between columns. */
const CHAR_W = 5;
const LINE_H = 12;
const FONT = 10;
const GUTTER_CHARS = 4;
const WRAP_CHARS = 100;

/** A full HS code. A row carrying one is data, never a header. */
const HS_FULL = /\b\d{4}\.\d{2}\.\d{2}\b/;

export interface TableRow {
  /** Row number in the source — the spreadsheet row, or the row within a Word table. */
  n: number;
  cells: string[];
}

export interface Paragraph {
  text: string;
  heading: boolean;
  /** 1-based paragraph number across the whole document. */
  n: number;
}

export type Part =
  | { kind: "prose"; label: string; paragraphs: Paragraph[] }
  | {
      kind: "table";
      label: string;
      /** What a single row is cited as: `Sheet "Tariff", row 42`. */
      rowLabel: (n: number) => string;
      /** Repeated on every part of the table, so each part reads on its own. */
      header: TableRow | null;
      rows: TableRow[];
    };

/** Squash whitespace inside a cell or paragraph. */
export function clean(s: string): string {
  return s.replace(/[ \s]+/g, " ").trim();
}

/** Drop columns that are empty in every row, and trailing empties. */
export function compactColumns(rows: TableRow[]): TableRow[] {
  const width = Math.max(0, ...rows.map((r) => r.cells.length));
  const used: number[] = [];
  for (let c = 0; c < width; c++) {
    if (rows.some((r) => (r.cells[c] ?? "") !== "")) used.push(c);
  }
  return rows.map((r) => ({ n: r.n, cells: used.map((c) => r.cells[c] ?? "") }));
}

/**
 * Split one table into parts, with its header found and repeated.
 *
 * The header is the first row, unless that row carries an HS code or has fewer
 * than two cells — then the table has no header and nothing is repeated. The
 * HS-code test matters most: repeating a
 * data row at the top of every part would stage the same tariff line once per
 * part, and a reviewer approving each would write duplicate obligations.
 */
export function tableParts(
  rows: TableRow[],
  label: (from: number, to: number) => string,
  rowLabel: (n: number) => string
): Part[] {
  const nonEmpty = compactColumns(rows.filter((r) => r.cells.some((c) => c !== "")));
  if (nonEmpty.length === 0) return [];

  // A header names at least two columns. A lone cell across the top is a title
  // or a sentence, and as a header it would never be indexed in its own right.
  const first = nonEmpty[0];
  const isHeader = first.cells.filter(Boolean).length >= 2 && !first.cells.some((c) => HS_FULL.test(c));
  const header = isHeader ? first : null;
  const body = header ? nonEmpty.slice(1) : nonEmpty;

  if (body.length === 0) {
    // A table that is nothing but a header is still text somebody may search for.
    return [{ kind: "table", label: label(first.n, first.n), rowLabel, header: null, rows: [first] }];
  }

  const parts: Part[] = [];
  for (let i = 0; i < body.length; i += ROWS_PER_PART) {
    const slice = body.slice(i, i + ROWS_PER_PART);
    parts.push({
      kind: "table",
      label: label(slice[0].n, slice[slice.length - 1].n),
      rowLabel,
      header,
      rows: slice,
    });
  }
  return parts;
}

/**
 * Group a run of paragraphs into prose parts.
 *
 * A heading starts a new part, so a part is usually one section of the
 * document; a long section is split once it passes PROSE_PART_CHARS.
 */
export function proseParts(paragraphs: Paragraph[]): Part[] {
  const parts: Part[] = [];
  let current: Paragraph[] = [];
  let chars = 0;
  let heading: string | null = null;

  const flush = () => {
    if (current.length === 0) return;
    const from = current[0].n;
    const to = current[current.length - 1].n;
    const span = from === to ? `paragraph ${from}` : `paragraphs ${from}–${to}`;
    const title = heading ?? (current[0].heading ? current[0].text : null);
    parts.push({
      kind: "prose",
      label: title ? `"${truncate(title, 60)}", ${span}` : span,
      paragraphs: current,
    });
    current = [];
    chars = 0;
  };

  for (const p of paragraphs) {
    if ((p.heading && current.length > 0) || chars > PROSE_PART_CHARS) flush();
    if (p.heading) heading = p.text;
    current.push(p);
    chars += p.text.length;
  }
  flush();
  return parts;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function item(str: string, x: number, y: number): TextItem {
  return { str, x, y, width: str.length * CHAR_W, height: FONT, fontSize: FONT, hasEOL: false };
}

/**
 * Lay a part out as a page.
 *
 * Table cells sit at fixed column offsets with a four-character gutter, which
 * comfortably clears the two-character minimum the gutter detector needs, so a
 * column boundary can never be mistaken for a word space. `rowAtY` maps each
 * line back to its source row for row-level citations.
 */
export function partToPage(part: Part, pageNo: number): { page: PdfPage; rowAtY: Map<number, number> } {
  const items: TextItem[] = [];
  const rowAtY = new Map<number, number>();
  let y = 0;
  let width = 0;

  if (part.kind === "table") {
    const lines = part.header ? [part.header, ...part.rows] : part.rows;
    const cols = Math.max(...lines.map((r) => r.cells.length));
    const offsets: number[] = [];
    let x = 0;
    for (let c = 0; c < cols; c++) {
      offsets.push(x);
      const widest = Math.max(1, ...lines.map((r) => (r.cells[c] ?? "").length));
      x += (widest + GUTTER_CHARS) * CHAR_W;
    }
    width = x;
    for (const row of lines) {
      row.cells.forEach((cell, c) => {
        if (cell) items.push(item(cell, offsets[c], y));
      });
      if (row !== part.header) rowAtY.set(y, row.n);
      y += LINE_H;
    }
  } else {
    for (const p of part.paragraphs) {
      for (const line of wrap(p.text)) {
        items.push(item(line, 0, y));
        width = Math.max(width, line.length * CHAR_W);
        y += LINE_H;
      }
      // A blank line between paragraphs, so the paragraph reflow sees the break.
      y += LINE_H;
    }
  }

  return {
    page: { page: pageNo, width: width + 2 * CHAR_W, height: y + LINE_H, items },
    rowAtY,
  };
}

function wrap(text: string): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > WRAP_CHARS) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

/**
 * One table row as a search result.
 *
 * With the header attached — "HS Code: 8471.30.00 | Description: Laptops |
 * Rate: 0%" — a hit on one row reads on its own, which a bare "8471.30.00 |
 * Laptops | 0%" does not once it is lifted out of its table.
 */
export function rowText(row: TableRow, header: TableRow | null): string {
  return row.cells
    .map((cell, i) => {
      if (!cell) return "";
      const name = header?.cells[i];
      return name ? `${name}: ${cell}` : cell;
    })
    .filter(Boolean)
    .join(" | ");
}
