/**
 * Generic tariff-schedule reader.
 *
 * The CET parser works because someone sat with poppler's output and tuned a
 * regex to that one document's column widths. That does not survive contact
 * with a hundred documents nobody has seen. This one reads the page's real
 * column geometry, finds which column holds what by reading the header row, and
 * takes the rows off the grid — so an unfamiliar schedule can be read without
 * anyone hand-tuning a pattern first.
 *
 * Everything it produces is a PROPOSAL. It goes to staging with the source text
 * attached, and an officer approves it before it can affect any assessment.
 * That is what makes a generic parser safe to run on documents nobody has
 * inspected: being wrong costs a rejected row, not a wrong duty.
 */
import { detectColumns, rowsFromColumns } from "../../pdf/columns";
import type { GridRow } from "../../pdf/columns";
import type { PdfPage } from "../../pdf/types";
import { normalizePrefix } from "../../hs";
import { parseRate } from "../rates";

/** What a column holds, worked out from its header text. */
export type ColumnRole = "hsCode" | "description" | "unit" | "rate" | "heading" | "unknown";

const ROLE_PATTERNS: { role: ColumnRole; re: RegExp }[] = [
  { role: "hsCode", re: /\b(h\.?\s*s\.?\s*code|tariff\s*(no|number)|commodity\s*code|hs\s*heading)\b/i },
  { role: "heading", re: /^\s*heading\b/i },
  { role: "description", re: /\b(description|commodity|goods|item)\b/i },
  { role: "unit", re: /\b(unit|quantity|uoq)\b/i },
  { role: "rate", re: /\b(rate|duty|edd|import\s*duty|tariff\s*rate|%)\b/i },
];

const HS_FULL = /\b(\d{4}\.\d{2}\.\d{2})\b/;
const RATE_TOKEN = /(\b\d{1,3}\s*%|^\s*Free\s*$|^\s*SI\s*$)/i;

export interface ScheduleRow {
  hsPrefix: string;
  hsCode: string;
  rate: number | null;
  specificRate: string | null;
  needsReview: boolean;
  description: string;
  page: number;
  /** The whole source row, so a reviewer sees exactly what was read. */
  snippet: string;
  /** 0..1, how cleanly this row parsed. Not a claim about legal correctness. */
  confidence: number;
}

export interface ScheduleParseResult {
  rows: ScheduleRow[];
  linesSeen: number;
  /** Pages where a usable column grid was found. */
  pagesWithGrid: number;
  /** Column roles, as read from the header of the first page that had one. */
  roles: ColumnRole[];
}

/** Work out what each column holds by matching the header row's cells. */
export function assignRoles(rows: GridRow[], columnCount: number): ColumnRole[] {
  const roles: ColumnRole[] = new Array(columnCount).fill("unknown");

  // The header is the topmost row whose cells match role names rather than data.
  for (const row of rows.slice(0, 8)) {
    let matched = 0;
    const candidate: ColumnRole[] = new Array(columnCount).fill("unknown");
    row.cells.forEach((cell, i) => {
      if (!cell) return;
      for (const { role, re } of ROLE_PATTERNS) {
        if (re.test(cell)) {
          candidate[i] = role;
          matched++;
          break;
        }
      }
    });
    if (matched >= 2) return candidate;
  }
  return roles;
}

/**
 * Fall back to position when a page has no readable header.
 *
 * Government schedules are consistent about shape even when the header does not
 * repeat on every page: the code is on the left, the rate on the right, and the
 * description is the widest column between them.
 */
function inferRoles(rows: GridRow[], columnCount: number): ColumnRole[] {
  const roles: ColumnRole[] = new Array(columnCount).fill("unknown");
  const hsHits = new Array(columnCount).fill(0);
  const rateHits = new Array(columnCount).fill(0);
  const lengths = new Array(columnCount).fill(0);

  for (const row of rows) {
    row.cells.forEach((cell, i) => {
      if (!cell) return;
      if (HS_FULL.test(cell)) hsHits[i]++;
      if (RATE_TOKEN.test(cell)) rateHits[i]++;
      lengths[i] += cell.length;
    });
  }

  const hsCol = argmax(hsHits);
  const rateCol = argmax(rateHits);
  if (hsHits[hsCol] > 0) roles[hsCol] = "hsCode";
  if (rateHits[rateCol] > 0 && rateCol !== hsCol) roles[rateCol] = "rate";

  // The description is the wordiest column that is not already spoken for.
  let descCol = -1;
  let best = 0;
  for (let i = 0; i < columnCount; i++) {
    if (roles[i] !== "unknown") continue;
    if (lengths[i] > best) {
      best = lengths[i];
      descCol = i;
    }
  }
  if (descCol >= 0) roles[descCol] = "description";
  return roles;
}

function argmax(xs: number[]): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
  return best;
}

/**
 * Read every priced tariff row a document contains.
 *
 * A row must carry both a full HS code and something rate-shaped; anything
 * else is skipped rather than guessed at. Rows whose rate cannot be read
 * cleanly still come through, flagged, because a row an officer completes is
 * recoverable and a row silently dropped is not.
 */
export function parseSchedule(pages: PdfPage[]): ScheduleParseResult {
  const out: ScheduleRow[] = [];
  let linesSeen = 0;
  let pagesWithGrid = 0;
  let reportedRoles: ColumnRole[] = [];

  for (const page of pages) {
    const columns = detectColumns(page);
    if (columns.length < 2) continue;
    pagesWithGrid++;

    const grid = rowsFromColumns(page, columns);
    let roles = assignRoles(grid, columns.length);
    if (!roles.includes("hsCode") || !roles.includes("rate")) {
      roles = inferRoles(grid, columns.length);
    }
    if (!reportedRoles.length) reportedRoles = roles;

    const hsCol = roles.indexOf("hsCode");
    const rateCol = roles.indexOf("rate");
    const descCol = roles.indexOf("description");
    if (hsCol < 0 || rateCol < 0) continue;

    for (const row of grid) {
      const codeCell = row.cells[hsCol] ?? "";
      const code = codeCell.match(HS_FULL)?.[1];
      if (!code) continue;
      linesSeen++;

      const rateCell = (row.cells[rateCol] ?? "").trim();
      if (!rateCell) continue;

      const parsed = parseRate(rateCell);
      if (!parsed) continue;

      const description = (descCol >= 0 ? row.cells[descCol] : "").replace(/^[-\s]+/, "").trim();
      const snippet = row.cells.filter(Boolean).join("  |  ");

      out.push({
        hsPrefix: normalizePrefix(code),
        hsCode: code,
        rate: parsed.rate,
        specificRate: parsed.specificRate,
        // Everything a generic parser produces needs a person to confirm it.
        // The flag here marks rows that are additionally uncertain on their own
        // terms — a sensitive item, or a two-part rate.
        needsReview: parsed.needsReview || parsed.rate === null,
        description,
        page: page.page,
        snippet,
        confidence: scoreRow(parsed.rate !== null, description.length > 0, roles),
      });
    }
  }

  return { rows: out, linesSeen, pagesWithGrid, roles: reportedRoles };
}

/**
 * How cleanly this row parsed — not how likely it is to be legally right.
 * Used only to order the review queue so the messiest rows are looked at first.
 */
function scoreRow(hasRate: boolean, hasDescription: boolean, roles: ColumnRole[]): number {
  let score = 0.5;
  if (hasRate) score += 0.25;
  if (hasDescription) score += 0.15;
  if (roles.includes("unit")) score += 0.1; // a full header was read
  return Math.min(1, score);
}
