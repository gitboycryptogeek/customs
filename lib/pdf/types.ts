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

/**
 * How a document's text was obtained. Recorded so a reader knows what they have.
 * The last three are read straight from the file's own structure (lib/office).
 */
export type ExtractionMethod = "text-layer" | "ocr" | "docx" | "xlsx" | "csv";

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
  /**
   * Search chunks, when the reader knows the document's structure better than
   * paragraph detection would — a spreadsheet is chunked one row per chunk, with
   * its column headings attached. Absent for PDFs, which go through the chunker.
   */
  chunks?: { text: string; page: number }[];
  /**
   * How to cite a position, when "p.N" is not how this document is cited:
   * `Sheet "Tariff", row 42`. `y` is a line's top edge on the page, as the
   * column reader reports it. Absent for PDFs.
   */
  locate?: (page: number, y?: number) => string;
}
