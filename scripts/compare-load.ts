/**
 * Compare a freshly-loaded database against fixtures/baseline.json.
 *
 * The baseline used to be the committed prisma/customs.db. A database that is
 * also the app's live dev store is a poor fixture — whatever a user ingested
 * became part of the "ground truth" — so the rows were lifted into a committed
 * JSON file covering only the four published-law PDFs. See
 * scripts/export-baseline.ts.
 *
 * The two are held to different standards on purpose:
 *
 *   obligations  MUST match exactly. This is the money. A rate that moved
 *                because the PDF toolchain changed is the failure this whole
 *                exercise exists to prevent.
 *
 *   amendments   MUST be a superset. They are a human review queue, so finding
 *                more is an improvement — but losing one means a law change
 *                nobody is told about.
 *
 *   conditions   Split: the hand-written levy conditions must match exactly;
 *   & chunks     the OCR-derived review pointers and text chunks are reported
 *                but not gated, because line segmentation legitimately differs
 *                between OCR engines and none of it feeds a total.
 *
 *   npx tsx scripts/compare-load.ts <new-db-path>
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const NEW = process.argv[2];
const BASELINE = "fixtures/baseline.json";

if (!NEW) {
  console.error("usage: tsx scripts/compare-load.ts <new-db-path>");
  process.exit(1);
}

type Table = { columns: string[]; rows: unknown[][] };
const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as {
  documents: string[];
  obligations: Table;
  duty: Table;
  amendments: Table;
  conditions: Table;
  reviewPointerCodes: string[];
  chunks: { total: number; tariff: number };
};

const a = new DatabaseSync(NEW, { readOnly: true });

/** Scope every query to the shipped documents, so a user's own are never compared. */
const placeholders = baseline.documents.map(() => "?").join(",");
function rows<T>(sql: string): T[] {
  return a.prepare(sql).all(...baseline.documents) as T[];
}

let failed = false;

function gate(ok: boolean, label: string, detail = "") {
  if (!ok) failed = true;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

function info(label: string, detail: string) {
  console.log(`  ....  ${label}  — ${detail}`);
}

/** A baseline table as comparable strings, in the column order it records. */
const baseRows = (t: Table) => t.rows.map((r) => JSON.stringify(r));
/** Database rows as the same, pulled through the baseline's column order. */
const dbRows = (t: Table, got: Record<string, unknown>[]) =>
  got.map((r) => JSON.stringify(t.columns.map((c) => r[c] ?? null)));

console.log(`Comparing ${NEW}\n     against ${BASELINE}\n`);

// --- Obligations: exact ------------------------------------------------------
const obA = dbRows(
  baseline.obligations,
  rows<Record<string, unknown>>(
    `SELECT o.hsPrefix, o.type, CAST(o.rate AS TEXT) rate, o.basis, o.needsReview, o.sourcePage
       FROM obligations o JOIN source_versions s ON s.id = o.sourceVersionId
      WHERE s.sourceFile IN (${placeholders})
      ORDER BY o.hsPrefix, o.type, o.rate, o.sourcePage`
  )
);
const obB = baseRows(baseline.obligations);
gate(
  obA.length === obB.length && obA.every((r, i) => r === obB[i]),
  `obligations identical (${obA.length} vs ${obB.length})`,
  obA.length === obB.length ? "" : "row counts differ"
);
if (obA.length === obB.length) {
  const diffs = obA.filter((r, i) => r !== obB[i]).slice(0, 5);
  for (const d of diffs) console.log(`         differing row: ${d}`);
}

// --- Amendments: superset by (act, section) ----------------------------------
type Am = { targetAct: string; targetSection: string };
const key = (act: string, section: string) => `${section} of the ${act}`;
const amA = new Set(
  rows<Am>(
    `SELECT a.targetAct, a.targetSection FROM amendments a
       JOIN source_versions s ON s.id = a.sourceVersionId
      WHERE s.sourceFile IN (${placeholders})`
  ).map((r) => key(r.targetAct, r.targetSection))
);
const amB = baseline.amendments.rows.map((r) => key(String(r[0]), String(r[1])));
const lost = amB.filter((k) => !amA.has(k));
gate(
  lost.length === 0,
  `amendments superset (${amA.size} found, ${amB.length} in baseline)`,
  lost.length ? `lost: ${lost.join("; ")}` : `${amA.size - amB.length} newly found`
);

// --- Conditions: the authored ones exactly, OCR pointers reported ------------
const cA = dbRows(
  baseline.conditions,
  rows<Record<string, unknown>>(
    `SELECT c.conditionType, c.detail FROM conditions c
       JOIN source_versions s ON s.id = c.sourceVersionId
      WHERE c.detail NOT LIKE '[REVIEW%' AND s.sourceFile IN (${placeholders})
      ORDER BY c.conditionType, c.detail`
  )
);
const cB = baseRows(baseline.conditions);
gate(
  cA.length === cB.length && cA.every((r, i) => r === cB[i]),
  `levy conditions identical (${cA.length} vs ${cB.length})`
);

// Which HS codes the gazette review pointers reference matters more than how many
// lines they were split across. But most of the codes on either side are OCR
// misreads of a scanned gazette — "0550", "2490" — so comparing the raw sets just
// measures which noise each engine produced. Gate only on codes that are real:
// ones that actually exist in the tariff. Losing a pointer to a genuine tariff
// line would mean an officer never sees a measure that applies to it.
const realCodes = new Set(baseline.obligations.rows.map((r) => String(r[0])));
const hsA = new Set(
  rows<{ hsPrefix: string }>(
    `SELECT DISTINCT c.hsPrefix FROM conditions c
       JOIN source_versions s ON s.id = c.sourceVersionId
      WHERE s.sourceFile IN (${placeholders})`
  ).map((r) => r.hsPrefix)
);
const realB = baseline.reviewPointerCodes.filter((h) => h && realCodes.has(h));
const lostReal = realB.filter((h) => !hsA.has(h));
const retained = realB.length ? (realB.length - lostReal.length) / realB.length : 1;

// Not equality, and deliberately so. The gazette is a poor scan whose table rows
// OCR unreliably — "3506.10.00 Silicon Sealant" is legible to a person and to
// neither engine consistently, at any resolution. The old CLI tesseract caught
// some rows this one misses and vice versa, so neither set is ground truth and
// asserting they match would be asserting something untrue. What a broken
// pipeline would look like is a collapse in overlap, which this catches.
const THRESHOLD = 0.85;
gate(
  retained >= THRESHOLD,
  `gazette pointers to real tariff codes retained ${(retained * 100).toFixed(1)}% (min ${THRESHOLD * 100}%)`,
  lostReal.length ? `${lostReal.length} of ${realB.length} differ, e.g. ${lostReal.slice(0, 6).join(", ")}` : "all retained"
);
const noiseLost = baseline.reviewPointerCodes.filter((h) => h && !realCodes.has(h) && !hsA.has(h)).length;
info("unreadable code strings", `${noiseLost} differ — OCR misreads on both sides, all bound for human review`);

// --- Chunks: searchability, reported ----------------------------------------
const counts = rows<{ total: number; tariff: number }>(
  `SELECT COUNT(*) total, SUM(CASE WHEN ch.sectionRef GLOB '[0-9]*' THEN 1 ELSE 0 END) tariff
     FROM chunks ch JOIN source_versions s ON s.id = ch.sourceVersionId
    WHERE s.sourceFile IN (${placeholders})`
)[0];
gate(
  counts.tariff === baseline.chunks.tariff,
  `tariff description chunks identical (${counts.tariff} vs ${baseline.chunks.tariff})`
);
info("all chunks", `${counts.total} vs ${baseline.chunks.total} (prose paragraphing differs; not gated)`);

a.close();

console.log("");
console.log(failed ? "LOAD COMPARISON FAILED" : "LOAD COMPARISON OK");
process.exit(failed ? 1 : 0);
