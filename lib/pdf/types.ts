// Shared shapes for the PDF toolchain. Everything downstream — the layout
// reconstructor, the column detector, the classifier and every parser — works
// off these, so there is exactly one representation of "what is on this page".

/** One run of text as the PDF draws it, in top-left origin coordinates. */
export interface TextItem {
  str: string;
  /** Left edge, in PDF points from the left of the page. */
  x: number;
  /** Top edge, in PDF points from the TOP of the page (pdf.js is flipped for us). */
  y: number;
  width: number;
  height: number;
  fontSize: number;
  /** pdf.js reports whether a run ends a line; useful for prose reflow. */
  hasEOL: boolean;
}

export interface PdfPage {
  /** 1-based physical page number — the number `#page=N` expects in a viewer. */
  page: number;
  width: number;
  height: number;
  items: TextItem[];
}

/**
 * OCR result for one page.
 *
 * Carries word geometry as well as text, so a scanned page becomes the same
 * PdfPage shape a text-layer page does. That matters: legislation is routinely
 * set in two columns with marginal notes, and without positions the margin
 * interleaves into the body text mid-sentence. With them, the same gutter and
 * column logic works on a scan as on a born-digital PDF.
 */
export interface OcrPage {
  page: number;
  text: string;
  /** Mean word confidence 0..1, or -1 when unknown. */
  confidence: number;
  /** Word boxes converted to PDF points. Empty only if the engine returned none. */
  items: TextItem[];
  /**
   * Words a second pass rescued from a region the first pass dropped whole.
   * Nearly always 0; when it is not, the page had a hole in it worth knowing
   * about. See ./recover.ts.
   */
  recovered: number;
  /** Page size in PDF points, derived from the rendered bitmap and its DPI. */
  width: number;
  height: number;
}

/** How a document's text was obtained. Recorded so a reader knows what they have. */
export type ExtractionMethod = "text-layer" | "ocr";

export interface ExtractedDocument {
  pages: PdfPage[];
  /** Layout-reconstructed text, one entry per page, index+1 = page number. */
  pageText: string[];
  method: ExtractionMethod;
  /** Mean OCR confidence across pages, or null for a text-layer document. */
  meanOcrConfidence: number | null;
  /**
   * Words rescued across the whole document from regions OCR dropped whole.
   * Worth surfacing: it means pages that would otherwise have looked complete
   * were not.
   */
  recoveredWords: number;
  pageCount: number;
}
