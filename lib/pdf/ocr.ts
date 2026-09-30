// OCR for scanned documents — the replacement for the `tesseract` CLI.
//
// tesseract.js is the same Tesseract engine compiled to WebAssembly, so a
// Windows user with nothing installed gets the same result as a Linux box with
// tesseract on PATH. Language data is vendored under vendor/tessdata so this
// never reaches the network: an officer's machine may well be offline, and a
// silent CDN fetch is not something this project should be doing anyway.
//
// Per CLAUDE.md, confidence is recorded per page rather than discarded — a
// low-confidence chunk is evidence a human should look at the original.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { renderPages, OCR_DPI } from "./render";
import { findUnreadBands, cropToPng } from "./recover";
import type { Box, UnreadBand } from "./recover";
import type { OcrPage, TextItem } from "./types";

/**
 * Directory holding `eng.traineddata.gz`.
 *
 * Resolution order matters for the packaged app: electron-builder copies
 * vendor/tessdata into resources/, and electron/main.js passes that path down
 * as TESSDATA_PATH. In the repo it is simply ./vendor/tessdata.
 */
export function tessdataPath(): string {
  const candidates = [
    process.env.TESSDATA_PATH,
    join(process.cwd(), "vendor", "tessdata"),
    join(process.cwd(), "..", "vendor", "tessdata"),
    resourcesPath() ? join(resourcesPath()!, "tessdata") : undefined,
  ].filter((p): p is string => Boolean(p));

  for (const dir of candidates) {
    if (existsSync(join(dir, "eng.traineddata.gz"))) return dir;
  }
  throw new Error(
    `Language data not found (looked in: ${candidates.join(", ")}). ` +
      "vendor/tessdata/eng.traineddata.gz must ship with the app."
  );
}

/** Electron sets process.resourcesPath; plain Node does not declare it. */
function resourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

/** True when OCR can actually run — checked before a document is queued. */
export function ocrAvailable(): boolean {
  try {
    tessdataPath();
    return true;
  } catch {
    return false;
  }
}

type Worker = Awaited<ReturnType<typeof import("tesseract.js").createWorker>>;

/**
 * Tesseract's "sparse text" page segmentation — find text in no particular
 * order, and do not try to make a page layout out of it. The literal value
 * rather than tesseract.js's PSM enum, which is only reachable through the
 * main module and would pull it in eagerly.
 */
const PSM_SPARSE_TEXT = "11";

/**
 * How sure the engine has to be about a word before it is allowed to fill a
 * hole the first pass left. A recovered word goes into a searchable index and
 * a reviewer's snippet with nothing marking it as second-hand, so the bar is
 * higher than for text that was read normally.
 *
 * Measured rather than guessed: across the corpus the genuine recoveries — the
 * cells of a freight table, a duty-remission row — come back at 87 to 97, while
 * what the engine makes of a coat of arms or a signature sits in the 40s and
 * 60s. Anything below this is noise dressed as a word, and a hole in a document
 * is better than a plausible wrong string sitting in the index.
 */
const MIN_RECOVERED_CONFIDENCE = 70;

/** One word as the engine reports it, in the pixel coordinates of the image read. */
interface RawWord {
  str: string;
  box: Box;
  /** The engine's own 0..100 for this word. */
  confidence: number;
  endsLine: boolean;
}

/** The result of one recognition call, before any coordinate conversion. */
interface RawPass {
  text: string;
  /** Tesseract's own 0..100, or -1 when it reported none. */
  confidence: number;
  words: RawWord[];
  lines: Box[];
}

/** Do two boxes cover enough of the same place to be the same word? */
function overlaps(a: Box, b: Box): boolean {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return false;
  const smaller = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
  return smaller > 0 && (w * h) / smaller > 0.3;
}

function toItem(word: RawWord, scale: number): TextItem {
  const height = (word.box.y1 - word.box.y0) / scale;
  return {
    str: word.str,
    x: word.box.x0 / scale,
    y: word.box.y0 / scale,
    width: (word.box.x1 - word.box.x0) / scale,
    height,
    fontSize: height,
    hasEOL: word.endsLine,
  };
}

/**
 * Mean confidence across passes, weighted by words read.
 *
 * Reported 0..1, with -1 for "unknown", matching the ocrConfidence column.
 */
function mean(values: number[]): number {
  const known = values.filter((v) => v >= 0);
  return known.length ? known.reduce((s, v) => s + v, 0) / known.length : -1;
}

function meanConfidence(passes: RawPass[]): number {
  let words = 0;
  let total = 0;
  for (const pass of passes) {
    if (pass.confidence < 0 || pass.words.length === 0) continue;
    words += pass.words.length;
    total += pass.confidence * pass.words.length;
  }
  return words > 0 ? total / words / 100 : -1;
}

/**
 * A reusable OCR worker. Starting one costs ~2s (WASM compile + loading the
 * language model), so a 100-document ingest must not start one per page.
 */
export class OcrEngine {
  private worker: Worker | null = null;

  async start(): Promise<void> {
    if (this.worker) return;
    const { createWorker } = await import("tesseract.js");
    this.worker = await createWorker("eng", 1, {
      langPath: tessdataPath(),
      gzip: true,
      // Never write a cache: the app directory is read-only when packaged, and
      // we already ship the only language file we use.
      cacheMethod: "none",
      logger: () => {},
      errorHandler: () => {},
    });
  }

  /**
   * Recognise one rendered page.
   *
   * Two passes at most. The first reads the whole page. If that leaves a band
   * of the page holding ink but no words — see ./recover.ts, and the bordered
   * table that started it — the band is cut out and read on its own, and
   * whatever comes back is merged in at its position on the page.
   *
   * `scale` converts boxes from bitmap pixels back to PDF points, so a scanned
   * page ends up in the same coordinate system as a born-digital one and the
   * layout and column code can treat the two identically.
   */
  async recognize(
    page: { png: Buffer; gray: Uint8Array; width: number; height: number },
    scale = 1
  ): Promise<{ text: string; confidence: number; items: TextItem[]; recovered: number }> {
    const first = await this.read(page.png);

    const bands = findUnreadBands({
      lines: first.lines,
      gray: page.gray,
      width: page.width,
      height: page.height,
    });

    const passes: RawPass[] = [first];
    for (const band of bands) {
      const found = await this.readBand(page.gray, page.width, band, first.words);
      if (found) passes.push(found);
    }

    const words = passes.flatMap((p) => p.words).sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
    const recovered = words.length - first.words.length;

    return {
      text: passes
        .map((p) => p.text)
        .filter(Boolean)
        .join("\n"),
      // Weighted by how much each pass actually read, so a page whose table was
      // recovered at 83% is not reported at the 89% the clean prose scored.
      confidence: meanConfidence(passes),
      items: words.map((w) => toItem(w, scale)),
      recovered,
    };
  }

  /** One recognition pass over an image, in that image's own pixel coordinates. */
  private async read(image: Buffer, params: Record<string, string> = {}): Promise<RawPass> {
    if (!this.worker) await this.start();
    // Any Tesseract parameter passed here is saved and restored around the call
    // by tesseract.js, so a second pass cannot leave the shared worker in a
    // different mode for the next page.
    const { data } = await this.worker!.recognize(image, params, { blocks: true, text: true });

    // tesseract.js does not export these node types, so describe the shape we
    // actually walk rather than casting the whole result to any.
    type OcrWord = { text?: string; bbox?: Box; confidence?: number };
    type OcrLine = { words?: OcrWord[] };
    type OcrBlock = { paragraphs?: { lines?: OcrLine[] }[] };

    const words: RawWord[] = [];
    const lines: Box[] = [];
    for (const block of (data as unknown as { blocks?: OcrBlock[] }).blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          const kept: RawWord[] = [];
          const raw = line.words ?? [];
          for (let i = 0; i < raw.length; i++) {
            const text = (raw[i].text ?? "").trim();
            const bbox = raw[i].bbox;
            if (!text || !bbox) continue;
            kept.push({
              str: text,
              box: bbox,
              confidence: typeof raw[i].confidence === "number" ? raw[i].confidence! : -1,
              endsLine: i === raw.length - 1,
            });
          }
          if (kept.length === 0) continue;
          words.push(...kept);
          lines.push({
            x0: Math.min(...kept.map((w) => w.box.x0)),
            y0: Math.min(...kept.map((w) => w.box.y0)),
            x1: Math.max(...kept.map((w) => w.box.x1)),
            y1: Math.max(...kept.map((w) => w.box.y1)),
          });
        }
      }
    }

    return {
      text: (data.text ?? "").replace(/[ \t]+\n/g, "\n").trim(),
      confidence: typeof data.confidence === "number" ? data.confidence : -1,
      words,
      lines,
    };
  }

  /**
   * Re-read one band and translate what it finds back to page coordinates.
   *
   * Sparse segmentation, not the page default: a band is by definition content
   * the page-level layout analysis already refused to treat as text, and asking
   * it a second time in the same terms gets the same answer. Told to expect
   * scattered text and nothing else, the engine reads the table cells it
   * dropped.
   *
   * Returns null when the band yields nothing worth keeping, which is the
   * honest outcome for a gap that held a signature, a stamp or a logo.
   */
  private async readBand(
    gray: Uint8Array,
    width: number,
    band: UnreadBand,
    already: RawWord[]
  ): Promise<RawPass | null> {
    const crop = await cropToPng(gray, width, band);
    const pass = await this.read(crop, { tessedit_pageseg_mode: PSM_SPARSE_TEXT });

    const moved = pass.words
      .map((w) => ({
        ...w,
        box: {
          x0: w.box.x0 + band.left,
          y0: w.box.y0 + band.top,
          x1: w.box.x1 + band.left,
          y1: w.box.y1 + band.top,
        },
      }))
      // Two filters, both about not making things up. A band's edges can still
      // clip the line above or below, so anything already read is dropped; and
      // an engine pointed at a signature will return letters for it, so a word
      // it has no confidence in is worse than the gap it fills.
      .filter((w) => w.confidence >= MIN_RECOVERED_CONFIDENCE)
      .filter((w) => !already.some((seen) => overlaps(seen.box, w.box)));

    if (moved.length === 0) return null;
    return {
      text: moved.map((w) => w.str).join(" "),
      confidence: mean(moved.map((w) => w.confidence)),
      words: moved,
      lines: [],
    };
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }
}

export interface OcrOptions {
  dpi?: number;
  firstPage?: number;
  lastPage?: number;
  /** Progress callback — OCR is slow enough that a UI must be able to show it. */
  onPage?: (page: number, total: number, confidence: number) => void;
  /** Cooperative cancellation for a queued 600-page document. */
  signal?: AbortSignal;
}

/**
 * OCR a scanned PDF page by page.
 *
 * Budget roughly 2-4 seconds per page: a 300-page Act is 15-20 minutes. Callers
 * that hold a user's attention must report progress and allow cancellation
 * rather than pretending this is fast.
 */
export async function ocrPdf(filePath: string, opts: OcrOptions = {}): Promise<OcrPage[]> {
  const engine = new OcrEngine();
  await engine.start();
  const out: OcrPage[] = [];
  try {
    const dpi = opts.dpi ?? OCR_DPI;
    const scale = dpi / 72; // bitmap pixels per PDF point

    for await (const rendered of renderPages(filePath, {
      dpi,
      firstPage: opts.firstPage,
      lastPage: opts.lastPage,
    })) {
      if (opts.signal?.aborted) throw new Error("OCR cancelled");
      const { text, confidence, items, recovered } = await engine.recognize(rendered, scale);
      out.push({
        page: rendered.page,
        text,
        confidence,
        items,
        recovered,
        width: rendered.width / scale,
        height: rendered.height / scale,
      });
      opts.onPage?.(rendered.page, out.length, confidence);
    }
    return out;
  } finally {
    await engine.stop();
  }
}
