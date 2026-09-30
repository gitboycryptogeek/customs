// The PDF toolchain. One implementation shared by the CLI loaders and the
// running app, so a document parsed on a developer's Linux box and the same
// document parsed on an officer's Windows laptop yield identical rows — which
// is the whole point of rule 1 in CLAUDE.md.
//
// Nothing here shells out. The previous implementation called pdftotext,
// pdffonts, pdftoppm and tesseract, none of which exist on a stock Windows
// machine, which is why a packaged user could not load a single document.

export type { PdfPage, TextItem, OcrPage, ExtractedDocument, ExtractionMethod } from "./types";
export { extractPages, pageCount, hasTextLayer } from "./extract";
export { toLines, layoutPage, layoutPages, paragraphsPage, charWidth } from "./layout";
export type { Line } from "./layout";
export { renderPages, OCR_DPI } from "./render";
export { ocrPdf, ocrAvailable, tessdataPath, OcrEngine } from "./ocr";
export { sha256File, sha256Buffer } from "./hash";
export { detectColumns, rowsFromColumns } from "./columns";
export type { Column, GridRow } from "./columns";
export { stripMarginColumn, withoutMargin, bodyText } from "./margins";
export type { MarginReport } from "./margins";
export { findUnreadBands, cropToPng } from "./recover";
export type { UnreadBand } from "./recover";

import { extractPages, hasTextLayer, pageCount } from "./extract";
import { layoutPages } from "./layout";
import { ocrPdf } from "./ocr";
import type { ExtractedDocument } from "./types";

export interface ExtractDocumentOptions {
  /** Force a path instead of auto-detecting. Useful when a classifier already decided. */
  method?: "text-layer" | "ocr" | "auto";
  onProgress?: (stage: "extract" | "ocr", page: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Get a document's text by whichever route it needs, with the method recorded.
 *
 * This is the single entry point the ingest pipeline uses. A document with a
 * text layer is read directly; a scan is rasterised and OCR'd. The caller is
 * told which happened, because "this figure came from OCR at 71% confidence" is
 * information an officer reviewing a rate is entitled to.
 */
export async function extractDocument(
  filePath: string,
  opts: ExtractDocumentOptions = {}
): Promise<ExtractedDocument> {
  const total = await pageCount(filePath);
  const wanted = opts.method ?? "auto";
  const useOcr = wanted === "ocr" || (wanted === "auto" && !(await hasTextLayer(filePath)));

  if (!useOcr) {
    const pages = await extractPages(filePath, {
      onPage: (p) => opts.onProgress?.("extract", p, total),
    });
    return {
      pages,
      pageText: layoutPages(pages),
      method: "text-layer",
      meanOcrConfidence: null,
      recoveredWords: 0,
      pageCount: total,
    };
  }

  const ocr = await ocrPdf(filePath, {
    signal: opts.signal,
    onPage: (p) => opts.onProgress?.("ocr", p, total),
  });
  const confident = ocr.filter((p) => p.confidence >= 0);
  // OCR carries word boxes, so a scanned page becomes the same PdfPage a
  // born-digital one does and goes through the identical layout grid. Without
  // this, a two-column statute reads as body text with marginal notes spliced
  // into the middle of its sentences.
  const ocrPages = ocr.map((p) => ({
    page: p.page,
    width: p.width,
    height: p.height,
    items: p.items,
  }));

  return {
    pages: ocrPages,
    // Fall back to the engine's own text for any page that returned no boxes.
    pageText: ocrPages.map((p, i) => (p.items.length ? layoutPages([p])[0] : ocr[i].text)),
    method: "ocr",
    meanOcrConfidence: confident.length
      ? confident.reduce((s, p) => s + p.confidence, 0) / confident.length
      : null,
    recoveredWords: ocr.reduce((s, p) => s + p.recovered, 0),
    pageCount: total,
  };
}

/**
 * Layout text per page — the drop-in replacement for `pdftotext -layout` split
 * on form feeds. Index + 1 is the physical page number, which is what a
 * viewer's `#page=N` anchor expects.
 */
export async function pdfToPages(filePath: string): Promise<string[]> {
  return layoutPages(await extractPages(filePath));
}
