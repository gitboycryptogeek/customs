/**
 * Export the loader baseline — the hand-verified ground truth the parsers are
 * held to.
 *
 * This used to be the committed prisma/customs.db itself. That made a database
 * both a build output and a test fixture, and it meant anything a user ingested
 * through the Documents page landed in the repo's ground truth: an internal memo
 * dropped into the app became a public file. The database is now built
 * (`npm run db:build`) and this file, which holds only rows read out of the four
 * published-law PDFs in public/docs/, is what the loaders are compared against.
 *
 * Regenerate it only when a loader legitimately improves, and review the diff —
 * that diff IS the claim that the change was intended.
 *
 *   npx tsx scripts/export-baseline.ts [db-path]   # default prisma/customs.db
 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

/**
 * The shipped documents, by the sourceFile the loaders record. Scoping to these
 * is what keeps a user's own documents out of the baseline — theirs are stored
 * under a content hash, so they can never match this list.
 */
const SHIPPED = ["cet.pdf", "misc-fees-and-levies.pdf", "finance-act-2026.pdf", "routine-order-2026.pdf"];

const DB = process.argv[2] ?? "prisma/customs.db";
const OUT = "fixtures/baseline.json";

const db = new DatabaseSync(DB, { readOnly: true });

/** `?,?,?,?` and the shipped list, for scoping every query below. */
const placeholders = SHIPPED.map(() => "?").join(",");
const scoped = (sql: string) => db.prepare(sql).all(...SHIPPED);

const sourceIds = scoped(
  `SELECT id, sourceFile FROM source_versions WHERE sourceFile IN (${placeholders})`
) as { id: string; sourceFile: string }[];

const missing = SHIPPED.filter((f) => !sourceIds.some((s) => s.sourceFile === f));
if (missing.length) {
  console.error(`${DB} is missing loaded documents: ${missing.join(", ")}`);
  console.error("Run `npm run db:build` first — a baseline must cover all four.");
  process.exit(1);
}

// --- Obligations: every row, exactly. This is the money. --------------------
const obligations = scoped(
  `SELECT o.hsPrefix, o.type, CAST(o.rate AS TEXT) rate, o.basis, o.needsReview, o.sourcePage
     FROM obligations o JOIN source_versions s ON s.id = o.sourceVersionId
    WHERE s.sourceFile IN (${placeholders})
    ORDER BY o.hsPrefix, o.type, o.rate, o.sourcePage`
);

// --- The CET duty rows on their own, which is what parity diffs against. ----
const duty = scoped(
  `SELECT o.hsPrefix, o.rate, o.needsReview, o.sourcePage
     FROM obligations o JOIN source_versions s ON s.id = o.sourceVersionId
    WHERE o.type = 'duty' AND s.docType = 'A' AND s.sourceFile IN (${placeholders})
    ORDER BY o.hsPrefix`
);

// --- Amendments: a review queue, so the gate is "no fewer", by key. ---------
const amendments = scoped(
  `SELECT a.targetAct, a.targetSection
     FROM amendments a JOIN source_versions s ON s.id = a.sourceVersionId
    WHERE s.sourceFile IN (${placeholders})
    ORDER BY a.targetAct, a.targetSection`
);

// --- Conditions: the authored levy ones exactly; OCR pointers by code. ------
const conditions = scoped(
  `SELECT c.conditionType, c.detail
     FROM conditions c JOIN source_versions s ON s.id = c.sourceVersionId
    WHERE c.detail NOT LIKE '[REVIEW%' AND s.sourceFile IN (${placeholders})
    ORDER BY c.conditionType, c.detail`
);

const reviewPointers = scoped(
  `SELECT DISTINCT c.hsPrefix
     FROM conditions c JOIN source_versions s ON s.id = c.sourceVersionId
    WHERE c.detail LIKE '[REVIEW%' AND c.hsPrefix IS NOT NULL AND s.sourceFile IN (${placeholders})
    ORDER BY c.hsPrefix`
) as { hsPrefix: string }[];

// --- Chunks: tariff descriptions are gated, prose paragraphing is not. ------
const chunkCounts = scoped(
  `SELECT COUNT(*) total, SUM(CASE WHEN ch.sectionRef GLOB '[0-9]*' THEN 1 ELSE 0 END) tariff
     FROM chunks ch JOIN source_versions s ON s.id = ch.sourceVersionId
    WHERE s.sourceFile IN (${placeholders})`
)[0] as { total: number; tariff: number };

db.close();

/**
 * Rows as `{ columns, rows }` with one row per line.
 *
 * 5,710 pretty-printed objects is a megabyte of repeated key names, and a single
 * line is a fixture nobody can review. Positional rows, one to a line, keep the
 * file small and keep `git diff` pointing at the tariff line that moved.
 */
function table(rows: Record<string, unknown>[], columns: string[]) {
  return {
    columns,
    rows: rows.map((r) => columns.map((c) => r[c] ?? null)),
  };
}

/** A `{ columns, rows }` table, rows one per line, as a JSON fragment. */
function serialiseTable(rows: Record<string, unknown>[], columns: string[], indent: string) {
  const lines = table(rows, columns).rows.map((r) => `${indent}  ${JSON.stringify(r)}`);
  return `{\n${indent} "columns": ${JSON.stringify(columns)},\n${indent} "rows": [\n${lines.join(
    ",\n"
  )}\n${indent} ]\n${indent}}`;
}

const json = `{
 "note": ${JSON.stringify(
   "Hand-verified loader output for the four published-law PDFs in public/docs/. " +
     "Regenerate with `npx tsx scripts/export-baseline.ts` and review the diff."
 )},
 "generatedAt": ${JSON.stringify(new Date().toISOString())},
 "documents": ${JSON.stringify(SHIPPED)},
 "obligations": ${serialiseTable(
   obligations as Record<string, unknown>[],
   ["hsPrefix", "type", "rate", "basis", "needsReview", "sourcePage"],
   " "
 )},
 "duty": ${serialiseTable(
   duty as Record<string, unknown>[],
   ["hsPrefix", "rate", "needsReview", "sourcePage"],
   " "
 )},
 "amendments": ${serialiseTable(
   amendments as Record<string, unknown>[],
   ["targetAct", "targetSection"],
   " "
 )},
 "conditions": ${serialiseTable(
   conditions as Record<string, unknown>[],
   ["conditionType", "detail"],
   " "
 )},
 "reviewPointerCodes": ${JSON.stringify(reviewPointers.map((r) => r.hsPrefix))},
 "chunks": ${JSON.stringify(chunkCounts)}
}
`;

writeFileSync(OUT, json);

console.log(`Wrote ${OUT}`);
console.log(`  obligations        ${obligations.length}`);
console.log(`  of which CET duty  ${duty.length}`);
console.log(`  amendments         ${amendments.length}`);
console.log(`  levy conditions    ${conditions.length}`);
console.log(`  review pointers    ${reviewPointers.length} distinct HS codes`);
console.log(`  chunks             ${chunkCounts.total} (${chunkCounts.tariff} tariff)`);
