// Dropping marginal note columns.
//
// Kenyan and EAC legislation is set with the operative text in a wide body
// column and cross-references ("Amendment of section 2 of Cap. 470.") in a
// narrow margin. CLAUDE.md is explicit that the margins carry no substance and
// should be ignored — but they cannot simply be ignored, they have to be
// removed, because both OCR and pdf.js read across the page and splice the
// margin into the middle of a sentence:
//
//   "2. Section 2 of the Income Tax Act is amended in arene,
//    subsection (1)—"
//
// That "in arene," is a garbled margin note sitting inside the sentence. Any
// parser reading such text sees a broken statute, which is why the amendment
// extractor found nothing until this existed.

import { toLines, detectGutters, medianCharWidth } from "./layout";
import type { PdfPage, TextItem } from "./types";

export interface MarginReport {
  /** Items kept — the body text. */
  items: TextItem[];
  /** Whether a margin column was found and removed. */
  stripped: boolean;
  /** Left edge of the removed column, in points. */
  marginStart: number | null;
}

/**
 * Remove a narrow right-hand marginal column, if one is present.
 *
 * Identified by three properties together, so ordinary table columns and
 * ragged prose are left alone:
 *   1. it sits to the right of a full-height gutter;
 *   2. it is narrow — well under a third of the text width;
 *   3. it is sparse — text appears on only a minority of the page's lines.
 *
 * A real table's rightmost column (a rate column, say) fails the third test:
 * it has a value on nearly every row.
 */
export function stripMarginColumn(page: PdfPage): MarginReport {
  const lines = toLines(page);
  if (lines.length < 8) return { items: page.items, stripped: false, marginStart: null };

  const gutters = detectGutters(page, lines);
  if (gutters.length === 0) return { items: page.items, stripped: false, marginStart: null };

  const textLeft = Math.min(...page.items.map((i) => i.x));
  const textRight = Math.max(...page.items.map((i) => i.x + i.width));
  const textWidth = textRight - textLeft;
  if (textWidth <= 0) return { items: page.items, stripped: false, marginStart: null };

  // Consider only gutters in the right-hand third — a margin note column never
  // starts in the middle of the page.
  const candidates = gutters.filter((g) => g.end > textLeft + textWidth * 0.6 && g.end < textRight);

  for (const gutter of [...candidates].sort((a, b) => a.end - b.end)) {
    const columnStart = gutter.end;
    const columnWidth = textRight - columnStart;
    if (columnWidth > textWidth * 0.32) continue; // too wide to be a margin

    const linesWithMargin = lines.filter((l) =>
      l.items.some((i) => i.str.trim() && i.x + i.width / 2 >= columnStart)
    ).length;
    const occupancy = linesWithMargin / lines.length;
    // Sparse enough to be annotation, but present enough to be a real column.
    if (occupancy > 0.45 || occupancy < 0.05) continue;

    return {
      items: page.items.filter((i) => i.x + i.width / 2 < columnStart),
      stripped: true,
      marginStart: columnStart,
    };
  }

  return { items: page.items, stripped: false, marginStart: null };
}

/** The same page with any marginal note column removed. */
export function withoutMargin(page: PdfPage): PdfPage {
  const { items } = stripMarginColumn(page);
  return items === page.items ? page : { ...page, items };
}

/**
 * Reflow a statute page into sentences of body text.
 *
 * Strips the margin, joins the body lines into a single stream, and repairs
 * words broken across a line break. Amendment sentences routinely wrap, and a
 * regex looking for "is amended by inserting" will not match across a newline
 * with a hyphen in it.
 */
export function bodyText(page: PdfPage): string {
  const clean = withoutMargin(page);
  const lines = toLines(clean);
  const pitch = medianCharWidth(lines);
  void pitch;

  let out = "";
  for (const line of lines) {
    const text = line.items
      .map((i) => i.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    if (!out) {
      out = text;
      continue;
    }
    // "proce-\nssing" -> "processing"; otherwise join with a space.
    if (/[A-Za-z]-$/.test(out)) out = out.slice(0, -1) + text;
    else out += " " + text;
  }
  return out;
}
