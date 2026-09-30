// Text-layer extraction via pdf.js — the replacement for `pdftotext`/`pdffonts`.
//
// Why pdf.js rather than shelling out to poppler: the packaged desktop app runs
// on machines with no poppler, no tesseract and no Node toolchain at all. This
// is pure JS, so the CLI loaders and the running app share one implementation
// and therefore one parse result, which is what the determinism rule in
// CLAUDE.md actually requires.
//
// We keep pdf.js's item geometry instead of throwing it away, because column
// positions are far more reliable than counting spaces in `pdftotext -layout`
// output — that is what lets a generic parser read a tariff table it has never
// seen before (see ./columns.ts).

import { workerSrc, standardFontDataUrl } from "./resolve";
import type { PdfPage, TextItem } from "./types";

// pdf.js v4 ships ESM only. Load it once, lazily: importing it costs ~40ms and
// most code paths (assessment, search) never touch a PDF at all.
type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function pdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((mod) => {
      // Point pdf.js at its own worker bundle. In Node it has no real worker
      // thread and loads that module in-process ("fake worker"), which is what
      // we want for a batch loader — but it still refuses to start unless
      // workerSrc names something it can resolve.
      if (mod.GlobalWorkerOptions) mod.GlobalWorkerOptions.workerSrc = workerSrc();
      return mod;
    });
  }
  return pdfjsPromise;
}

export interface ExtractOptions {
  /** 1-based, inclusive. Omit for the whole document. */
  firstPage?: number;
  lastPage?: number;
  /** Called after each page so a long document can report progress. */
  onPage?: (page: number, total: number) => void;
}

/**
 * Read every text run out of a PDF with its position on the page.
 *
 * Coordinates are converted to a top-left origin (y grows downward) because
 * every consumer here thinks in reading order, and pdf.js's bottom-left origin
 * is a persistent source of off-by-a-page-height bugs.
 */
export async function extractPages(filePath: string, opts: ExtractOptions = {}): Promise<PdfPage[]> {
  const { readFile } = await import("node:fs/promises");
  const mod = await pdfjs();
  const data = new Uint8Array(await readFile(filePath));

  const doc = await mod.getDocument({
    data,
    standardFontDataUrl: standardFontDataUrl(),
    // Untrusted input: never let a document execute anything.
    isEvalSupported: false,
    useSystemFonts: false,
    // Suppress pdf.js's console noise on the malformed government PDFs that
    // make up most of this corpus; a broken font is not our problem as long as
    // the text runs come out.
    verbosity: 0,
  }).promise;

  try {
    const first = Math.max(1, opts.firstPage ?? 1);
    const last = Math.min(doc.numPages, opts.lastPage ?? doc.numPages);
    const pages: PdfPage[] = [];

    for (let n = first; n <= last; n++) {
      const page = await doc.getPage(n);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const items: TextItem[] = [];

        for (const raw of content.items) {
          if (!("str" in raw)) continue; // marked-content markers, not text
          const str = raw.str;
          if (!str) continue;
          // transform = [a, b, c, d, e, f]; e,f are the origin of the run and
          // |d| is the effective font size once the text matrix is applied.
          const [, , , d, e, f] = raw.transform as number[];
          const fontSize = Math.abs(d) || raw.height || 0;
          items.push({
            str,
            x: e,
            // Flip to a top-left origin; f is the BASELINE, so lift by the
            // font size to get the top of the glyph box.
            y: viewport.height - f - fontSize,
            width: raw.width ?? 0,
            height: raw.height || fontSize,
            fontSize,
            hasEOL: Boolean(raw.hasEOL),
          });
        }

        pages.push({ page: n, width: viewport.width, height: viewport.height, items });
        opts.onPage?.(n, last);
      } finally {
        page.cleanup();
      }
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}

/** Page count without paying to extract any text. */
export async function pageCount(filePath: string): Promise<number> {
  const { readFile } = await import("node:fs/promises");
  const mod = await pdfjs();
  const data = new Uint8Array(await readFile(filePath));
  const doc = await mod.getDocument({ data, isEvalSupported: false, verbosity: 0 }).promise;
  try {
    return doc.numPages;
  } finally {
    await doc.destroy();
  }
}

/**
 * Does this document have a usable text layer?
 *
 * Replaces `pdffonts` (whose empty font table meant "scanned"). A font table is
 * an indirect signal anyway — several documents in this corpus declare fonts and
 * still yield no characters. Measuring actual extracted characters per page is
 * both more direct and available without poppler.
 *
 * Sampled over a spread of pages so a 600-page scan doesn't cost a full extract,
 * and so a document with a text-layer cover page over scanned body pages is
 * correctly called scanned.
 */
export async function hasTextLayer(filePath: string, minCharsPerPage = 50): Promise<boolean> {
  const total = await pageCount(filePath);
  const sample = samplePages(total, 8);
  let chars = 0;
  for (const n of sample) {
    const [p] = await extractPages(filePath, { firstPage: n, lastPage: n });
    if (p) chars += p.items.reduce((sum, i) => sum + i.str.trim().length, 0);
  }
  return chars / sample.length >= minCharsPerPage;
}

/** Evenly spread page numbers across a document, always including the middle. */
function samplePages(total: number, want: number): number[] {
  if (total <= want) return Array.from({ length: total }, (_, i) => i + 1);
  const step = total / want;
  const out = new Set<number>();
  for (let i = 0; i < want; i++) out.add(Math.max(1, Math.min(total, Math.round(i * step + step / 2))));
  return [...out].sort((a, b) => a - b);
}
