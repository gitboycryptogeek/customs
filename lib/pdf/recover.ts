// Recovering page regions that OCR silently dropped.
//
// Tesseract's whole-page layout analysis sometimes discards a region entirely
// rather than reading it badly. A bordered table is the common case: the header
// row comes back as ordinary text and the cells below it never appear in the
// output at all. Nothing about the result says so — the page reports a healthy
// confidence, the text reads as continuous prose, and the only trace is a
// vertical hole in the word boxes where content used to be.
//
// That is the worst shape a failure can take here. A low confidence score is
// evidence a person should open the original; a region that vanished leaves no
// evidence at all, and the document is then filed as "fully searchable" while
// the only operative numbers in it are missing from the index.
//
// So: after the first pass, look for a band of the page that carries ink but
// produced no words, and read that band again on its own. Restricting the image
// to the band is what makes the difference — the same engine on the same pixels
// reads a table it dropped when the table was one region among many.
//
// The check is deliberately conservative. It runs off geometry already in hand
// plus a darkness count over a few hundred rows of the bitmap, and it only ever
// looks BETWEEN two lines that were read successfully. Trailing whitespace at
// the foot of a short page, a blank verso, and a page that failed wholesale all
// fall outside it, because re-reading those costs seconds a page across a
// 600-page scan and buys nothing.

/** A box in rendered-bitmap pixels, top-left origin. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * A horizontal slice of the page that appears to hold unread content.
 *
 * The bounds are the crop to re-read, and they deliberately reach out to take
 * in the line above the hole and the line below it. Those two lines were read
 * the first time and will be read again — the caller drops the duplicates —
 * but handing the engine a bare strip of table cells with no ordinary text
 * either side measurably degrades what it makes of them. On the memo this was
 * built for, the tight crop turned 2,500 into "25," and "500" and lost a row
 * outright; the same crop with its neighbouring lines attached read every cell
 * correctly. Context is cheaper than accuracy.
 */
export interface UnreadBand {
  /** Bitmap pixel bounds of the crop to re-read. */
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** Rows of unaccounted-for ink inside it — the evidence for re-reading it. */
  inkedRows: number;
}

export interface RecoverOptions {
  /** Line boxes from the first pass, in bitmap pixels. */
  lines: Box[];
  /** One byte of darkness per pixel, 0 black .. 255 white, row-major. */
  gray: Uint8Array;
  width: number;
  height: number;
}

/** Below this, a pixel counts as ink rather than paper. */
const INK_LEVEL = 176;

/** Fewest lines that have to have been read before a hole in them means anything. */
const MIN_LINES = 8;

/** A gap has to be this many times the usual line height to be worth looking at. */
const GAP_LINES = 1.6;

/** Bands closer together than this (in line heights) are read as one crop. */
const MERGE_LINES = 1.2;

/** Most crops to re-read on one page. */
const MAX_BANDS = 4;

/** Never re-read more than this fraction of a page; past it, the page itself failed. */
const MAX_PAGE_FRACTION = 0.6;

/**
 * A row darker than this fraction of the text column is a printed rule, not
 * writing. Even justified body text leaves a quarter of a row as paper once
 * inter-word and inter-letter space is counted, whereas the double rules under
 * a letterhead run solid — and without a ceiling here every one of them reads
 * as a hole in the page and buys a wasted second pass.
 */
const SOLID_ROW = 0.75;

/** Pixels of slack around a crop, enough to save a glyph resting on the edge. */
const EDGE_PAD = 2;

/**
 * Find bands of the page that hold ink but produced no words.
 *
 * Returns crops in bitmap pixels, ordered top to bottom. An empty array means
 * the first pass accounted for everything on the page, which is the normal case
 * and costs nothing beyond this function.
 */
export function findUnreadBands(opts: RecoverOptions): UnreadBand[] {
  const { lines, gray, width, height } = opts;
  if (lines.length < MIN_LINES) return [];

  const sorted = [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lineHeight = median(sorted.map((l) => l.y1 - l.y0));
  if (!(lineHeight > 0)) return [];

  // The horizontal extent of what was read. Everything outside it is furniture
  // — a letterhead rule, the grey wedge down the side of a KRA memo — and
  // counting its ink would flag every gap between paragraphs on the page.
  const left = Math.max(0, Math.min(...sorted.map((l) => l.x0)));
  const right = Math.min(width - 1, Math.max(...sorted.map((l) => l.x1)));
  if (right - left < width * 0.2) return [];

  const minGap = Math.round(lineHeight * GAP_LINES);
  // A row counts as inked when a text-like run of it is dark. The floor clears
  // a table's vertical borders, which are a few columns wide; the ceiling
  // clears the solid horizontal rules a letterhead or a table draws, which
  // would otherwise make every rule on the page look like unread content.
  const span = right - left + 1;
  const minDarkPerRow = Math.max(4, Math.round(span * 0.02));
  const maxDarkPerRow = Math.round(span * SOLID_ROW);
  const minInkedRows = Math.max(4, Math.round(lineHeight * 0.3));

  const found: UnreadBand[] = [];
  // Lines are sorted by top edge, so a gap starts from the floor of everything
  // seen so far rather than from the previous line — two columns side by side
  // must not read as a hole in the page.
  let floor = sorted[0].y1;
  let above = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const gapTop = floor + 1;
    const gapBottom = sorted[i].y0 - 1;
    const below = sorted[i];
    if (below.y1 > floor) {
      floor = below.y1;
      above = below;
    }
    if (gapBottom - gapTop + 1 < minGap) continue;

    const inkedRows = countInkedRows(gray, width, left, right, gapTop, gapBottom, minDarkPerRow, maxDarkPerRow);
    if (inkedRows < minInkedRows) continue;

    found.push({
      top: Math.max(0, Math.min(above.y0, gapTop) - EDGE_PAD),
      bottom: Math.min(height - 1, Math.max(below.y1, gapBottom) + EDGE_PAD),
      left,
      right,
      inkedRows,
    });
  }

  return limit(merge(found, Math.round(lineHeight * MERGE_LINES)), height);
}

function countInkedRows(
  gray: Uint8Array,
  width: number,
  left: number,
  right: number,
  top: number,
  bottom: number,
  minDarkPerRow: number,
  maxDarkPerRow: number
): number {
  let rows = 0;
  for (let y = top; y <= bottom; y++) {
    let dark = 0;
    const base = y * width;
    for (let x = left; x <= right; x++) {
      if (gray[base + x] < INK_LEVEL) dark++;
    }
    if (dark >= minDarkPerRow && dark <= maxDarkPerRow) rows++;
  }
  return rows;
}

function merge(bands: UnreadBand[], within: number): UnreadBand[] {
  const out: UnreadBand[] = [];
  for (const band of bands) {
    const last = out[out.length - 1];
    if (last && band.top - last.bottom <= within) {
      last.bottom = band.bottom;
      last.inkedRows += band.inkedRows;
    } else {
      out.push({ ...band });
    }
  }
  return out;
}

/**
 * Keep the most promising few crops, and give up if they cover most of the page
 * — a page that is mostly unread is a failed page, and what to do about that is
 * the caller's decision, not this one's.
 */
function limit(bands: UnreadBand[], height: number): UnreadBand[] {
  const kept = [...bands].sort((a, b) => b.inkedRows - a.inkedRows).slice(0, MAX_BANDS);
  const covered = kept.reduce((sum, b) => sum + (b.bottom - b.top + 1), 0);
  if (covered > height * MAX_PAGE_FRACTION) return [];

  return kept.sort((a, b) => a.top - b.top);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Cut one band out of a rendered page as its own greyscale PNG.
 *
 * Built from the darkness map rather than by decoding the page PNG a second
 * time: OCR only ever sees grey, and a 600-page scan should not pay to decode
 * every page twice.
 */
export async function cropToPng(
  gray: Uint8Array,
  width: number,
  band: UnreadBand
): Promise<Buffer> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const w = band.right - band.left + 1;
  const h = band.bottom - band.top + 1;

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const src = (band.top + y) * width + band.left;
    const dst = y * w * 4;
    for (let x = 0; x < w; x++) {
      const v = gray[src + x];
      const i = dst + x * 4;
      image.data[i] = v;
      image.data[i + 1] = v;
      image.data[i + 2] = v;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toBuffer("image/png");
}
