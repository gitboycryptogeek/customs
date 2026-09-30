/**
 * Toolchain parity harness.
 *
 * The PDF toolchain moved off poppler/tesseract onto pdf.js/tesseract.js so the
 * packaged app can read documents on a machine with nothing installed. That
 * swap is only safe if it produces the SAME rows: a silently different rate,
 * carrying a legal citation, is this system's worst failure mode.
 *
 * This runs the one CET parser over text from both toolchains and diffs the
 * result against fixtures/baseline.json, the hand-verified ground truth the
 * fixtures were built against. That baseline used to be the committed
 * prisma/customs.db; the database is now a build output (`npm run db:build`), so
 * the rows it was trusted for live in a committed fixture instead.
 *
 *   npx tsx scripts/verify-parity.ts
 *
 * Poppler is optional — where it is absent the harness compares pdf.js against
 * the database only, and says so rather than quietly skipping a check.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { extractPages } from "../lib/pdf/extract";
import { layoutPages } from "../lib/pdf/layout";
import { parseCet } from "../lib/ingest/parsers/cet";
import type { CetRow } from "../lib/ingest/parsers/cet";

const CET = "public/docs/cet.pdf";
const BASELINE = "fixtures/baseline.json";

function popplerAvailable(): boolean {
  try {
    // `pdftotext -v` exits non-zero on several builds; run a real one-page
    // extraction instead, which is what we actually need it to be able to do.
    execFileSync("pdftotext", ["-layout", "-f", "1", "-l", "1", CET, "-"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function popplerPages(file: string): string[] {
  return execFileSync("pdftotext", ["-layout", file, "-"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 256,
  }).split("\f");
}

/** The CET duty rows the baseline records — hand-verified ground truth. */
function baselineRows(): Map<string, { rate: number | null; needsReview: boolean; page: number | null }> {
  const { duty } = JSON.parse(readFileSync(BASELINE, "utf8")) as {
    duty: { columns: string[]; rows: unknown[][] };
  };
  const col = (name: string) => duty.columns.indexOf(name);
  const [hs, rate, needsReview, page] = ["hsPrefix", "rate", "needsReview", "sourcePage"].map(col);
  return new Map(
    duty.rows.map((r) => [
      String(r[hs]),
      {
        rate: r[rate] === null ? null : Number(r[rate]),
        needsReview: Boolean(r[needsReview]),
        page: r[page] === null ? null : Number(r[page]),
      },
    ])
  );
}

function indexRows(rows: CetRow[]) {
  const m = new Map<string, CetRow>();
  for (const r of rows) m.set(r.hsPrefix, r); // last wins, as the loader's insert order does
  return m;
}

interface Diff {
  onlyA: string[];
  onlyB: string[];
  rateMismatch: { code: string; a: number | null; b: number | null }[];
  pageMismatch: number;
}

function diff(
  a: Map<string, { rate: number | null; page?: number | null }>,
  b: Map<string, { rate: number | null; page?: number | null }>
): Diff {
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  const rateMismatch: { code: string; a: number | null; b: number | null }[] = [];
  let pageMismatch = 0;

  for (const [code, av] of a) {
    const bv = b.get(code);
    if (!bv) {
      onlyA.push(code);
      continue;
    }
    const ar = av.rate === null ? null : Number(av.rate);
    const br = bv.rate === null ? null : Number(bv.rate);
    if (ar !== br) rateMismatch.push({ code, a: ar, b: br });
    if (av.page != null && bv.page != null && av.page !== bv.page) pageMismatch++;
  }
  for (const code of b.keys()) if (!a.has(code)) onlyB.push(code);
  return { onlyA, onlyB, rateMismatch, pageMismatch };
}

function report(label: string, d: Diff, expectLeft: string, expectRight: string): boolean {
  const ok = d.onlyA.length === 0 && d.onlyB.length === 0 && d.rateMismatch.length === 0;
  console.log(`\n${ok ? "PASS" : "FAIL"}  ${label}`);
  console.log(`   only in ${expectLeft}: ${d.onlyA.length}${d.onlyA.length ? "  e.g. " + d.onlyA.slice(0, 8).join(", ") : ""}`);
  console.log(`   only in ${expectRight}: ${d.onlyB.length}${d.onlyB.length ? "  e.g. " + d.onlyB.slice(0, 8).join(", ") : ""}`);
  console.log(`   rate mismatches: ${d.rateMismatch.length}`);
  for (const m of d.rateMismatch.slice(0, 10)) {
    console.log(`     ${m.code}: ${expectLeft}=${m.a}  ${expectRight}=${m.b}`);
  }
  console.log(`   page-number differences: ${d.pageMismatch}`);
  return ok;
}

async function main() {
  console.log("Toolchain parity check — EAC CET\n" + "=".repeat(60));

  const t0 = Date.now();
  const pages = layoutPages(await extractPages(CET));
  const pdfjsParse = parseCet(pages);
  console.log(
    `pdf.js   : ${pages.length} pages in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ` +
      `${pdfjsParse.rows.length} rows, ${pdfjsParse.stats.matched}/${pdfjsParse.stats.hsLinesSeen} HS lines ` +
      `(${pdfjsParse.stats.coveragePct.toFixed(1)}% coverage), ` +
      `SI seen ${pdfjsParse.stats.siCount}, unresolved ${pdfjsParse.stats.unresolvedSI}, ` +
      `compound ${pdfjsParse.stats.compoundCount}`
  );

  const database = baselineRows();
  console.log(`baseline : ${database.size} duty rows (ground truth)`);

  const pdfjsIdx = indexRows(pdfjsParse.rows);

  // THE GATE. The baseline was loaded and hand-verified against the fixtures, so
  // it is the only ground truth that counts. The new toolchain must reproduce it
  // exactly.
  const gate = report("baseline vs pdf.js (GATE)", diff(database, pdfjsIdx), "baseline", "pdf.js");

  // Informational only. Poppler's output quality varies sharply between builds
  // — the one on this machine reaches barely half the rows — so it is reported
  // for context and never allowed to fail the run.
  if (popplerAvailable()) {
    const t1 = Date.now();
    const pop = parseCet(popplerPages(CET));
    console.log("");
    console.log(
      `poppler  : ${((Date.now() - t1) / 1000).toFixed(1)}s -> ${pop.rows.length} rows, ` +
        `${pop.stats.matched}/${pop.stats.hsLinesSeen} HS lines (${pop.stats.coveragePct.toFixed(1)}% coverage)`
    );
    const popIdx = indexRows(pop.rows);
    const vsDb = diff(database, popIdx);
    console.log(
      `   this poppler build vs the baseline: ${vsDb.onlyA.length} rows missed, ` +
        `${vsDb.rateMismatch.length} rate mismatches (informational)`
    );
    if (vsDb.onlyA.length > 0 || vsDb.rateMismatch.length > 0) {
      console.log("   -> the local poppler build is NOT a valid oracle; the baseline is.");
    }
  } else {
    console.log("");
    console.log("poppler  : not installed (informational comparison skipped)");
  }

  console.log("");
  console.log("=".repeat(60));
  console.log(
    gate
      ? "PARITY OK — the pure-JS toolchain reproduces every duty row in the baseline."
      : "PARITY FAILED — the new toolchain does not reproduce the baseline."
  );
  process.exit(gate ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
