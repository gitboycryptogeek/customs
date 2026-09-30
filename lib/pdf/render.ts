// Rasterise PDF pages — the replacement for `pdftoppm -r 150`.
//
// Only scanned documents (Type B) need this: it exists to feed OCR, never to
// display anything. pdf.js draws into a canvas backed by @napi-rs/canvas, which
// ships prebuilt binaries for every platform we target, so there is nothing to
// compile on a user's machine.
//
// Note on placement: this runs inside the Next server, which the desktop app
// launches as a CHILD process (ELECTRON_RUN_AS_NODE) — it has no BrowserWindow
// and so cannot borrow Electron's Chromium to rasterise. Doing it here keeps
// `npm run dev` and the packaged app on one identical code path, which matters
// more than avoiding a prebuilt binary: two rendering paths would mean two
// possible OCR results from the same page.

import { workerSrc } from "./resolve";

/** Default rasterisation density. Matches the `pdftoppm -r 150` the OCR loaders used. */
export const OCR_DPI = 150;

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function pdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((mod) => {
      if (mod.GlobalWorkerOptions) mod.GlobalWorkerOptions.workerSrc = workerSrc();
      return mod;
    });
  }
  return pdfjsPromise;
}

export interface RenderedPage {
  page: number;
  png: Buffer;
  width: number;
  height: number;
  /**
   * One byte of darkness per pixel, 0 black .. 255 white, row-major.
   *
   * Carried alongside the PNG because the OCR stage has to answer "is there ink
   * where no words came back?", and decoding the PNG again to find out would
   * double the image cost of every page in a 600-page scan. It is taken from
   * the canvas that was drawn anyway.
   */
  gray: Uint8Array;
}

/**
 * Render a range of pages to PNG buffers at the given DPI.
 *
 * Pages are yielded one at a time rather than returned as an array: a 600-page
 * scan at 150dpi is several gigabytes of bitmap, and the OCR stage only ever
 * needs one page in hand.
 */
export async function* renderPages(
  filePath: string,
  opts: { dpi?: number; firstPage?: number; lastPage?: number } = {}
): AsyncGenerator<RenderedPage> {
  const { readFile } = await import("node:fs/promises");
  const { createCanvas } = await import("@napi-rs/canvas");
  const mod = await pdfjs();

  const dpi = opts.dpi ?? OCR_DPI;
  const scale = dpi / 72; // PDF user space is 72 units per inch
  const data = new Uint8Array(await readFile(filePath));
  const doc = await mod.getDocument({ data, isEvalSupported: false, verbosity: 0 }).promise;

  try {
    const first = Math.max(1, opts.firstPage ?? 1);
    const last = Math.min(doc.numPages, opts.lastPage ?? doc.numPages);

    for (let n = first; n <= last; n++) {
      const page = await doc.getPage(n);
      try {
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = canvas.getContext("2d");
        // Scanned pages are photographs of paper; a white ground keeps OCR from
        // seeing the transparent default as black and inverting everything.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({
          // @napi-rs/canvas implements the 2D context pdf.js needs, but its
          // types are its own rather than the DOM's.
          canvasContext: ctx as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise;

        yield {
          page: n,
          png: canvas.toBuffer("image/png"),
          width: canvas.width,
          height: canvas.height,
          gray: toGray(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height),
        };
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await doc.destroy();
  }
}

/** Rec. 601 luma, the same weighting the OCR engine applies before thresholding. */
function toGray(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < gray.length; p++, i += 4) {
    gray[p] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
  }
  return gray;
}
