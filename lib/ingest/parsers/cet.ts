/**
 * EAC Common External Tariff parser — extracted from scripts/load-cet.ts so the
 * loader, the in-app ingest pipeline and the parity harness all run the exact
 * same code over the exact same text. Two copies of this logic would mean two
 * possible answers for one tariff line, which rule 1 does not allow.
 *
 * Input is layout text, one entry per page (index + 1 = physical page number).
 */
import { normalizePrefix } from "../../hs";
import { parseRate, UNIT_COLUMN } from "../rates";

const HS_ROW = /^\s*(\d{4}\.\d{2}\.\d{2})\s+(.*\S)\s*$/;
const HEADING = /^\s*(\d{2}\.\d{2})\s+(.*\S)\s*$/; // e.g. "10.05   Maize (corn)."

export interface CetRow {
  hsPrefix: string;
  rate: number | null;
  specificRate: string | null;
  needsReview: boolean;
  description: string;
  legalRef: string;
  schedule: 1 | 2;
  isSI: boolean;
  page: number;
}

export interface CetParseResult {
  rows: CetRow[];
  stats: {
    hsLinesSeen: number;
    matched: number;
    siCount: number;
    compoundCount: number;
    resolvedSI: number;
    unresolvedSI: number;
    coveragePct: number;
  };
}

/** Extract the rate tail from a data line: the last whitespace-separated rate group. */
function splitRow(rest: string): { description: string; rateTail: string } | null {
  const m = rest.match(/^(.*?\S)\s{2,}((?:\d{1,3}\s*%.*)|SI|Free)\s*$/i);
  if (!m) return null;
  return { description: m[1].replace(UNIT_COLUMN, ""), rateTail: m[2] };
}

/** Page header/footer furniture that must never be joined into a description. */
function isFurniture(line: string): boolean {
  const t = line.trim();
  if (/COMMON EXTERNAL TARIFF|H\.S\.\s*Code|Tariff No|Unit of|Quantity|^Rate$/i.test(t)) return true;
  if (/^Heading\b/i.test(t) || /\bDescription\b.*\bRate\b/i.test(t)) return true;
  if (/^\d+$/.test(t)) return true; // bare page number
  if (/^[A-Z0-9 .,'"|()\-]{4,}$/.test(t) && !/[a-z]/.test(t)) return true; // all-caps banner
  return false;
}

/** Normalise CET text artifacts inside a description. */
function cleanDescription(s: string): string {
  return s
    .replace(/\u2011/g, "-") // non-breaking hyphen
    .replace(/^[-\s]+/, "") // leading dashes marking sub-levels
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Join a hyphenated split across a line break: "proce-", "ssing" -> "processing". */
function joinContinuation(base: string, cont: string): string {
  const c = cont.replace(/\u2011/g, "-").trim();
  if (base.endsWith("-")) return base.slice(0, -1) + c.replace(/^\s+/, "");
  return base + " " + c;
}

export function parseCet(pages: string[]): CetParseResult {
  let hsLinesSeen = 0;
  let matched = 0;
  let siCount = 0;
  let compoundCount = 0;
  const rows: CetRow[] = [];

  let currentHeading = "";
  let lastRowIndex = -1;
  // The CET has two schedules: Schedule 1 (main tariff, marks sensitive items
  // "SI") and Schedule 2 "SENSITIVE ITEMS" (p.555+) carrying their real rates.
  let schedule: 1 | 2 = 1;
  let page = 0;

  for (const pageText of pages) {
    page++;
    for (const raw of pageText.split("\n")) {
      const line = raw.replace(/\u00a0/g, " ");
      if (!line.trim()) continue;

      // Only the standalone all-caps banner is the real Schedule 2 header
      // (p.555). Mixed-case "Sensitive Items" in the intro/notes must NOT match.
      if (schedule === 1 && /^\s*SENSITIVE ITEMS\s*$/.test(line)) {
        schedule = 2;
        currentHeading = "";
        continue;
      }

      const h = line.match(HEADING);
      if (h && !HS_ROW.test(line)) {
        currentHeading = cleanDescription(h[2]);
        continue;
      }

      const r = line.match(HS_ROW);
      if (r) {
        hsLinesSeen++;
        const code = r[1];
        const split = splitRow(r[2]);
        if (!split) {
          lastRowIndex = -1;
          continue;
        }
        const parsed = parseRate(split.rateTail);
        if (!parsed) {
          lastRowIndex = -1;
          continue;
        }
        const rowDesc = cleanDescription(split.description);
        const fullDesc =
          currentHeading && rowDesc && rowDesc !== currentHeading
            ? `${currentHeading} — ${rowDesc}`
            : rowDesc || currentHeading;

        // In Schedule 2 the rate IS authoritative (it resolves the "SI"
        // pointer), so it is not needs-review purely for being sensitive —
        // only compound "higher-of" rates still are.
        const needsReview = schedule === 2 ? parsed.specificRate !== null : parsed.needsReview;
        const legalRef =
          schedule === 2
            ? `EAC CET 2022 (rev. Jun 2025), Schedule 2 (Sensitive Items), tariff ${code}`
            : `EAC CET 2022 (rev. Jun 2025), tariff ${code}`;

        rows.push({
          hsPrefix: normalizePrefix(code),
          rate: parsed.rate,
          specificRate: parsed.specificRate,
          needsReview,
          description: fullDesc,
          legalRef,
          schedule,
          isSI: parsed.isSI,
          page,
        });
        matched++;
        if (parsed.isSI) siCount++;
        if (parsed.specificRate) compoundCount++;
        lastRowIndex = rows.length - 1;
        continue;
      }

      // Continuation of the previous row's wrapped description.
      if (lastRowIndex >= 0 && !HEADING.test(line) && !isFurniture(line)) {
        const cont = cleanDescription(line.replace(UNIT_COLUMN, ""));
        if (cont) rows[lastRowIndex].description = joinContinuation(rows[lastRowIndex].description, cont);
      }
    }
  }

  // Resolve SI pointers: a Schedule-1 "SI" row (rate=null) is superseded by the
  // Schedule-2 row for the same code. Drop the null pointer so it neither
  // conflicts nor blocks — the Schedule-2 rate is the real, cited answer. Keep
  // any SI row with NO Schedule-2 match (genuinely unresolved -> needs_review).
  const sched2Prefixes = new Set(rows.filter((r) => r.schedule === 2).map((r) => r.hsPrefix));
  const before = rows.length;
  const finalRows = rows.filter((r) => !(r.schedule === 1 && r.isSI && sched2Prefixes.has(r.hsPrefix)));

  return {
    rows: finalRows,
    stats: {
      hsLinesSeen,
      matched,
      siCount,
      compoundCount,
      resolvedSI: before - finalRows.length,
      unresolvedSI: finalRows.filter((r) => r.isSI && r.rate === null).length,
      coveragePct: hsLinesSeen ? (matched / hsLinesSeen) * 100 : 0,
    },
  };
}
