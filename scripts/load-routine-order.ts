/**
 * Type D loader — EAC Gazette "Routine Order" of customs measures (scanned).
 * These carry conditions and time-bound measures (stays of duty, remissions,
 * duty-rate changes for the year) rather than the base tariff. They are legal
 * interpretation-heavy, so we do NOT auto-apply them to obligations. We:
 *   - OCR the scan automatically (pdf.js raster + tesseract.js), recording confidence;
 *   - make the text fully searchable;
 *   - record lines that reference an HS code as `conditions` (type restriction)
 *     tagged for human review — a person decides if a rate actually changes.
 *
 * Usage:  npx tsx scripts/load-routine-order.ts ./ROUTINE*.pdf [--dry-run]
 */
import { prisma } from "../lib/db";
import { extractDocument } from "../lib/pdf";
import { ocrAvailable } from "./lib/pdf";
import { ensureSourceVersion, parseArgs } from "./lib/source";

const EFFECTIVE_FROM = new Date("2026-07-01"); // "1st July 2026"
const HS_REF = /\b(\d{4}\.\d{2}\.\d{2}|\d{2}\.\d{2})\b/;

async function main() {
  const { file, dryRun } = parseArgs(process.argv);
  if (!file) {
    console.error("usage: tsx scripts/load-routine-order.ts <file.pdf> [--dry-run]");
    process.exit(1);
  }
  if (!ocrAvailable()) {
    console.error("OCR language data missing — expected vendor/tessdata/eng.traineddata.gz.");
    process.exit(1);
  }

  console.log(`Routine Order loader ${dryRun ? "(dry run) " : ""}— ${file}`);
  const doc = await extractDocument(file, {
    onProgress: (stage, page, total) => {
      if (page === 1 || page % 10 === 0) console.log(`  ${stage} page ${page}/${total}`);
    },
  });
  console.log(
    `  Read ${doc.pageCount} pages via ${doc.method}` +
      (doc.meanOcrConfidence !== null ? `, mean confidence ${(doc.meanOcrConfidence * 100).toFixed(1)}%` : "") +
      (doc.recoveredWords > 0 ? `, ${doc.recoveredWords} words recovered from skipped regions` : "")
  );
  const pages = doc.pageText.map((text, i) => ({ page: i + 1, text }));

  // Candidate measure lines: any sentence referencing an HS code.
  const measures: { hsPrefix: string; detail: string }[] = [];
  for (const p of pages) {
    for (const line of p.text.split("\n")) {
      const m = line.match(HS_REF);
      if (m && line.trim().length > 20) {
        measures.push({ hsPrefix: m[1].replace(/[^\d]/g, ""), detail: line.replace(/\s+/g, " ").trim() });
      }
    }
  }
  console.log(`  ${measures.length} HS-referencing measure lines found (for human review).`);

  if (dryRun) {
    for (const m of measures.slice(0, 8)) console.log(`  ${m.hsPrefix}: ${m.detail.slice(0, 80)}`);
    console.log("Dry run — nothing written. Measures are review pointers, not auto-applied rates.");
    return;
  }

  const src = await ensureSourceVersion(
    {
      path: file,
      title: "EAC Gazette Routine Order No.2 of 1 July 2026 — Customs Measures",
      issuer: "East African Community",
      docType: "D",
      effectiveFrom: EFFECTIVE_FROM,
      sourceFile: "routine-order-2026.pdf", // served from public/docs for deep links
    },
    dryRun
  );
  if (src.alreadyLoaded) {
    console.log(`Already loaded (hash ${src.contentHash.slice(0, 12)}). Nothing to do.`);
    return;
  }

  await prisma.condition.createMany({
    data: measures.map((m) => ({
      sourceVersionId: src.sourceVersionId,
      hsPrefix: m.hsPrefix,
      conditionType: "restriction",
      detail: `[REVIEW — gazette measure] ${m.detail}`,
      legalRef: "EAC Gazette Routine Order No.2, 1 Jul 2026",
      effectiveFrom: EFFECTIVE_FROM,
    })),
  });
  await prisma.chunk.createMany({
    data: pages
      .filter((p) => p.text.trim().length > 40)
      .map((p) => ({
        sourceVersionId: src.sourceVersionId,
        sectionRef: `p.${p.page}`,
        text: p.text,
        sourcePage: p.page,
        ocrConfidence: doc.meanOcrConfidence,
      })),
  });

  console.log(`Inserted ${measures.length} review conditions + OCR chunks.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
