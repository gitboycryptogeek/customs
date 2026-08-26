import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** sha256 of a file — the dedupe key for a SourceVersion. */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** pdffonts font-table lines (empty body => scanned, no text layer). */
export function pdfFonts(path: string): string {
  try {
    return execFileSync("pdffonts", [path], { encoding: "utf8" });
  } catch {
    return "";
  }
}

/** Whether the PDF has a usable text layer. */
export function hasTextLayer(path: string): boolean {
  const fonts = pdfFonts(path)
    .split("\n")
    .slice(2) // strip header + rule line
    .filter((l) => l.trim().length > 0);
  return fonts.length > 0;
}

/** Full document text via `pdftotext -layout` (preserves the CET column grid). */
export function pdfToTextLayout(path: string, firstPage?: number, lastPage?: number): string {
  const args = ["-layout"];
  if (firstPage) args.push("-f", String(firstPage));
  if (lastPage) args.push("-l", String(lastPage));
  args.push(path, "-");
  return execFileSync("pdftotext", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 256 });
}

/**
 * Full document text split into pages. `pdftotext` emits one form-feed (\f) per
 * page break, so the array index + 1 is the 1-based physical page number — the
 * same number a browser's `#page=N` anchor expects. Used to deep-link a figure
 * back to its exact page in the source PDF.
 */
export function pdfToPages(path: string): string[] {
  return pdfToTextLayout(path).split("\f");
}

export function tesseractAvailable(): boolean {
  try {
    execFileSync("tesseract", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface OcrPage {
  page: number;
  text: string;
  confidence: number; // mean word confidence 0..1, -1 if unknown
}

/**
 * OCR a scanned PDF: pdftoppm -r 150 -> per-page PNG -> tesseract.
 * Returns text + mean confidence per page. Requires tesseract on PATH.
 */
export function ocrPdf(path: string, dpi = 150): OcrPage[] {
  if (!tesseractAvailable()) {
    throw new Error(
      "tesseract not installed. Run: sudo apt install -y tesseract-ocr (see memory/ocr-blocker.md)"
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "ocr-"));
  try {
    execFileSync("pdftoppm", ["-r", String(dpi), "-png", path, join(dir, "p")], {
      maxBuffer: 1024 * 1024 * 512,
    });
    const pngs = readdirSync(dir)
      .filter((f) => f.endsWith(".png"))
      .sort();
    const pages: OcrPage[] = [];
    for (const png of pngs) {
      const pageNum = Number(png.match(/p-?(\d+)\.png/)?.[1] ?? "0");
      const base = join(dir, png.replace(/\.png$/, ""));
      // TSV output carries per-word confidence.
      const tsv = execFileSync("tesseract", [join(dir, png), base, "tsv"], {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "ignore"],
      });
      void tsv;
      const tsvText = readFileSync(`${base}.tsv`, "utf8");
      const { text, confidence } = parseTesseractTsv(tsvText);
      pages.push({ page: pageNum, text, confidence });
    }
    return pages;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseTesseractTsv(tsv: string): { text: string; confidence: number } {
  const lines = tsv.split("\n").slice(1); // drop header
  const words: string[] = [];
  let confSum = 0;
  let confN = 0;
  let curLine = -1;
  const parts: string[] = [];
  for (const raw of lines) {
    const cols = raw.split("\t");
    if (cols.length < 12) continue;
    const lineNum = Number(cols[4]);
    const conf = Number(cols[10]);
    const word = cols[11];
    if (!word || word.trim() === "") continue;
    if (curLine !== -1 && lineNum !== curLine) parts.push("\n");
    curLine = lineNum;
    words.push(word);
    parts.push(word + " ");
    if (conf >= 0) {
      confSum += conf;
      confN += 1;
    }
  }
  return {
    text: parts.join("").replace(/ \n/g, "\n").trim(),
    confidence: confN > 0 ? confSum / confN / 100 : -1,
  };
}
