/**
 * Type A loader — EAC Common External Tariff (CET 2022, updated June 2025).
 * Fixed-column schedule with a clean text layer. Extract with `pdftotext -layout`,
 * parse a column regex. ~5,900 duty rows in one pass.
 *
 * Handles the three known CET artifacts (see CLAUDE.md):
 *   - U+2011 non-breaking hyphen in descriptions -> "-"
 *   - words split across line breaks: "proce-ssing" -> "processing"
 *   - SI (Sensitive Item) rows: real rate is in Annex I, not here.
 *     Store rate=null, needsReview=true. NEVER coerce SI to 0.
 *
 * Usage:  npx tsx scripts/load-cet.ts ./CET*.pdf [--dry-run]
 */
import { prisma } from "../lib/db";
import { pdfToPages, hasTextLayer } from "./lib/pdf";
import { ensureSourceVersion, parseArgs } from "./lib/source";
import { normalizePrefix } from "../lib/hs";

const CET_EFFECTIVE_FROM = new Date("2025-06-01"); // "updated June 2025"
const HS_ROW = /^\s*(\d{4}\.\d{2}\.\d{2})\s+(.*\S)\s*$/;
const HEADING = /^\s*(\d{2}\.\d{2})\s+(.*\S)\s*$/; // e.g. "10.05   Maize (corn)."

interface ParsedRate {
  rate: number | null;
  specificRate: string | null;
  needsReview: boolean;
  isSI: boolean;
}

/** Parse the trailing rate token(s) of a CET data row. */
function parseRate(tail: string): ParsedRate | null {
  // Normalise "100 %" -> "100%", "$ 460" -> "$460" for matching.
  const t = tail.replace(/(\d)\s+%/g, "$1%").replace(/\$\s+/g, "$").trim();

  if (/^SI$/i.test(t)) return { rate: null, specificRate: null, needsReview: true, isSI: true };
  if (/^Free$/i.test(t)) return { rate: 0, specificRate: null, needsReview: false, isSI: false };

  const av = t.match(/^(\d{1,3})%/);
  if (!av) return null;
  const rate = Number(av[1]) / 100;

  // Compound "higher of ad valorem or specific" (e.g. "75% or $345/MT").
  // We keep the ad valorem rate but flag it: computing the higher-of needs the
  // specific unit rate & quantity, so a total must not be returned silently.
  if (/\bor\b/i.test(t) && /(\/MT|USD|\$)/i.test(t)) {
    return { rate, specificRate: t, needsReview: true, isSI: false };
  }
  return { rate, specificRate: null, needsReview: false, isSI: false };
}

const UNIT = /\s{2,}(kg|Kg|u|l|L|m|t|MT|g|ml|No\.?|pairs|Pairs|Ns|m2|m3|1000u|2u|doz|pcs|km)\s*$/;

/** Extract the rate tail from a data line: the last whitespace-separated rate group. */
function splitRow(rest: string): { description: string; rateTail: string } | null {
  // Rate sits at the far right after a run of spaces. Find the last 2+ space gap
  // that precedes something rate-shaped.
  const m = rest.match(/^(.*?\S)\s{2,}((?:\d{1,3}\s*%.*)|SI|Free)\s*$/i);
  if (!m) return null;
  // Drop the trailing unit-of-quantity column ("... - Other   u   25%").
  const description = m[1].replace(UNIT, "");
  return { description, rateTail: m[2] };
}

/** Page header/footer furniture that must never be joined into a description. */
function isFurniture(line: string): boolean {
  const t = line.trim();
  if (/COMMON EXTERNAL TARIFF|H\.S\.\s*Code|Tariff No|Unit of|Quantity|^Rate$/i.test(t)) return true;
  if (/^Heading\b/i.test(t) || /\bDescription\b.*\bRate\b/i.test(t)) return true; // column-header row
  if (/^\d+$/.test(t)) return true; // bare page number
  if (/^[A-Z0-9 .,'"|()\-]{4,}$/.test(t) && !/[a-z]/.test(t)) return true; // all-caps banner
  return false;
}

/** Normalise CET text artifacts inside a description. */
function cleanDescription(s: string): string {
  return s
    .replace(/‑/g, "-") // non-breaking hyphen
    .replace(/^[-\s]+/, "") // leading dashes marking sub-levels
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Join a hyphenated split across a line break: "proce-", "ssing" -> "processing". */
function joinContinuation(base: string, cont: string): string {
  const c = cont.replace(/‑/g, "-").trim();
  if (base.endsWith("-")) return base.slice(0, -1) + c.replace(/^\s+/, "");
  return base + " " + c;
}

async function main() {
  const { file, dryRun } = parseArgs(process.argv);
  if (!file) {
    console.error("usage: tsx scripts/load-cet.ts <file.pdf> [--dry-run]");
    process.exit(1);
  }
  if (!hasTextLayer(file)) {
    console.error("This PDF has no text layer — not a Type A document. Use OCR loader.");
    process.exit(1);
  }

  console.log(`CET loader ${dryRun ? "(dry run) " : ""}— ${file}`);
  const src = await ensureSourceVersion(
    {
      path: file,
      title: "EAC Common External Tariff 2022 (updated June 2025)",
      issuer: "East African Community",
      docType: "A",
      effectiveFrom: CET_EFFECTIVE_FROM,
      sourceFile: "cet.pdf", // served from public/docs for deep links
    },
    dryRun
  );
  if (src.alreadyLoaded) {
    console.log(`Already loaded (hash ${src.contentHash.slice(0, 12)}). Nothing to do.`);
    return;
  }

  // Split into pages (pdftotext emits \f per page): page index+1 = physical page
  // number, which is what a browser's #page=N deep link expects.
  const pages = pdfToPages(file);

  let hsLinesSeen = 0;
  let matched = 0;
  let siCount = 0;
  let compoundCount = 0;
  const rows: {
    hsPrefix: string;
    rate: number | null;
    specificRate: string | null;
    needsReview: boolean;
    description: string;
    legalRef: string;
    schedule: 1 | 2;
    isSI: boolean;
    page: number;
  }[] = [];

  let currentHeading = "";
  let lastRowIndex = -1;
  // The CET has two schedules: Schedule 1 (main tariff, marks sensitive items
  // "SI") and Schedule 2 "SENSITIVE ITEMS" (p.555+) which carries their real
  // rates. We switch context when we cross that header.
  let schedule: 1 | 2 = 1;
  let page = 0;

  for (const pageText of pages) {
    page++;
    for (const raw of pageText.split("\n")) {
    const line = raw.replace(/ /g, " ");
    if (!line.trim()) continue;

    // Only the standalone all-caps banner is the real Schedule 2 header
    // (p.555). Mixed-case "Sensitive Items" in the intro/notes must NOT match.
    if (schedule === 1 && /^\s*SENSITIVE ITEMS\s*$/.test(line)) {
      schedule = 2;
      currentHeading = "";
      continue;
    }

    // Heading like "10.05  Maize (corn)." — sets description context, no rate.
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
        // 8-digit code but no rate on this line (rare) — count as seen, skip.
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

      // In Schedule 2 the rate IS authoritative (it resolves the "SI" pointer),
      // so it is not needs-review purely for being sensitive — only compound
      // "higher-of" rates still are.
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
      const cont = cleanDescription(line.replace(UNIT, ""));
      if (cont) rows[lastRowIndex].description = joinContinuation(rows[lastRowIndex].description, cont);
    }
    }
  }

  // Resolve SI pointers: a Schedule-1 "SI" row (rate=null) is superseded by the
  // Schedule-2 row for the same code. Drop the null pointer so it neither
  // conflicts nor blocks — the Schedule-2 rate is the real, cited answer. Keep
  // any SI row that has NO Schedule-2 match (genuinely unresolved -> needs_review).
  const sched2Prefixes = new Set(rows.filter((r) => r.schedule === 2).map((r) => r.hsPrefix));
  const before = rows.length;
  const finalRows = rows.filter((r) => !(r.schedule === 1 && r.isSI && sched2Prefixes.has(r.hsPrefix)));
  const resolvedSI = before - finalRows.length;
  const unresolvedSI = finalRows.filter((r) => r.isSI && r.rate === null).length;

  const coverage = hsLinesSeen ? ((matched / hsLinesSeen) * 100).toFixed(1) : "0";
  console.log(`Parsed: ${matched} duty rows matched of ${hsLinesSeen} HS-code lines seen (${coverage}%)`);
  console.log(`  SI markers seen: ${siCount}; resolved via Schedule 2: ${resolvedSI}; still unresolved (rate=null, needs_review): ${unresolvedSI}`);
  console.log(`  Compound "higher-of" rates (needs_review): ${compoundCount}`);
  console.log(`  Rows to insert after SI resolution: ${finalRows.length}`);

  if (dryRun) {
    console.log("Dry run — sample of 8 parsed rows:");
    for (const row of finalRows.slice(0, 8)) {
      console.log(
        `  ${row.hsPrefix}  rate=${row.rate === null ? "NULL" : row.rate}  ${
          row.needsReview ? "[review] " : ""
        }${row.description.slice(0, 60)}`
      );
    }
    return;
  }

  // Insert obligations (duty). One row per HS item; store description in a chunk.
  const CHUNK = 500;
  for (let i = 0; i < finalRows.length; i += CHUNK) {
    const batch = finalRows.slice(i, i + CHUNK);
    await prisma.$transaction([
      prisma.obligation.createMany({
        data: batch.map((row) => ({
          sourceVersionId: src.sourceVersionId,
          hsPrefix: row.hsPrefix,
          type: "duty",
          rate: row.rate,
          specificRate: row.specificRate,
          basis: "customs_value",
          legalRef: row.legalRef,
          sourcePage: row.page,
          needsReview: row.needsReview,
          effectiveFrom: CET_EFFECTIVE_FROM,
        })),
      }),
      prisma.chunk.createMany({
        data: batch.map((row) => ({
          sourceVersionId: src.sourceVersionId,
          sectionRef: row.hsPrefix,
          text: row.description,
        })),
      }),
    ]);
  }
  console.log(`Inserted ${finalRows.length} duty obligations + ${finalRows.length} chunks.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
