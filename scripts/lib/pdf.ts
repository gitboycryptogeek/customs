/**
 * Compatibility shim for the loaders.
 *
 * These used to shell out to poppler and tesseract. They now go through
 * lib/pdf, which is pure JS/WASM and therefore also works inside the packaged
 * desktop app — where none of those binaries exist. The signatures are the same
 * apart from being async, since reading a PDF genuinely is asynchronous now.
 *
 * New code should import from `lib/pdf` directly.
 */
export {
  sha256File,
  sha256Buffer,
  hasTextLayer,
  pdfToPages,
  pageCount,
  extractPages,
  extractDocument,
  layoutPage,
  layoutPages,
  paragraphsPage,
  ocrPdf,
  ocrAvailable,
} from "../../lib/pdf";

export type { OcrPage, PdfPage, ExtractedDocument } from "../../lib/pdf";

/**
 * Kept so the OCR loaders read the same as before. OCR no longer depends on a
 * system tesseract — only on the language data we ship — so this now asks
 * whether that data is present.
 */
export { ocrAvailable as tesseractAvailable } from "../../lib/pdf";
