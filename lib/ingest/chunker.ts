// Splitting a document into searchable pieces.
//
// Granularity is the whole point. A chunk is what "Search the law" returns as a
// snippet and what it deep-links to, so chunking a statute by page gives a
// reader a wall of text and a page number, while chunking it by paragraph gives
// them the provision they were looking for. The Fees and Levies Act is 17 pages
// and about 255 paragraphs; the difference between those two numbers is the
// difference between a useful search result and a useless one.
//
// Tables are the exception: a tariff row means nothing on its own, and the CET
// is already chunked one row per HS code by its own loader.

import { paragraphsPage } from "../pdf/layout";
import type { PdfPage } from "../pdf/types";

export interface TextChunk {
  text: string;
  /** 1-based physical page, for the deep link back to the source. */
  page: number;
}

/** Shortest run of text worth indexing on its own. */
const MIN_CHUNK = 40;

/** Longest chunk before it stops being a useful snippet and gets split. */
const MAX_CHUNK = 2000;

/**
 * Chunk a document for search, by paragraph where paragraphs can be found and
 * by page otherwise.
 *
 * `pages` carries the item geometry needed to spot paragraph breaks; `pageText`
 * is the fallback for a page that has none — an OCR page whose engine returned
 * no boxes, say.
 */
export function chunkDocument(pages: PdfPage[], pageText: string[]): TextChunk[] {
  const out: TextChunk[] = [];

  pageText.forEach((text, i) => {
    const page = i + 1;
    const geometry = pages[i];

    const paragraphs =
      geometry && geometry.items.length > 0 ? paragraphsPage(geometry) : splitOnBlankLines(text);

    const chunks = chunkParagraphs(paragraphs, page);

    // If paragraph detection produced nothing usable, keep the page whole
    // rather than dropping it — a page that is hard to segment is still worth
    // being able to find.
    if (chunks.length === 0) {
      const whole = text.replace(/[ \t]+\n/g, "\n").trim();
      if (whole.length >= MIN_CHUNK) out.push({ text: whole, page });
      return;
    }

    out.push(...chunks);
  });

  return out;
}

/**
 * Chunk paragraphs already separated by their source — a Word document says
 * where its paragraphs are, so there is nothing to detect.
 */
export function chunkParagraphs(paragraphs: string[], page: number): TextChunk[] {
  const out: TextChunk[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.trim().length < MIN_CHUNK) continue;
    for (const piece of capLength(paragraph)) out.push({ text: piece, page });
  }
  return out;
}

/** Fallback segmentation for text with no geometry: blank lines. */
function splitOnBlankLines(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Split an over-long paragraph on sentence boundaries so snippets stay readable. */
function capLength(paragraph: string): string[] {
  const text = paragraph.replace(/\s+/g, " ").trim();
  if (text.length <= MAX_CHUNK) return [text];

  const out: string[] = [];
  let current = "";
  for (const sentence of text.split(/(?<=[.;:])\s+/)) {
    if (current && current.length + sentence.length > MAX_CHUNK) {
      out.push(current.trim());
      current = "";
    }
    current += (current ? " " : "") + sentence;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
