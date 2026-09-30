/**
 * Type C loader — Finance Act (amending Act). CRITICAL: a Finance Act contains
 * NO rates. It is a diff against other statutes:
 *   "Section 8 of the Income Tax Act is amended by deleting subsection (5A)."
 *
 * So it NEVER loads into obligations. It loads into `amendments` as a HUMAN
 * REVIEW QUEUE. A person decides which obligation rows change. We do not, ever,
 * auto-apply an amendment to the rates table — that is legal interpretation and
 * silently getting it wrong is this system's worst failure mode.
 *
 * This Finance Act is a scan: OCR runs automatically (rasterise with pdf.js,
 * recognise with tesseract.js) and per-page confidence is stored on each chunk.
 * The marginal note column is removed before parsing — see lib/pdf/margins.
 *
 * Usage:  npx tsx scripts/load-finance-act.ts ./Finance*.pdf [--dry-run]
 */
import { prisma } from "../lib/db";
import { extractDocument } from "../lib/pdf";
import { parseAmendments } from "../lib/ingest/parsers/amending-act";
import { ocrAvailable } from "./lib/pdf";
import { ensureSourceVersion, parseArgs } from "./lib/source";

const EFFECTIVE_FROM = new Date("2026-07-01"); // Finance Act 2026 commencement

async function main() {
  const { file, dryRun } = parseArgs(process.argv);
  if (!file) {
    console.error("usage: tsx scripts/load-finance-act.ts <file.pdf> [--dry-run]");
    process.exit(1);
  }
  if (!ocrAvailable()) {
    console.error("OCR language data missing — expected vendor/tessdata/eng.traineddata.gz.");
    process.exit(1);
  }

  console.log(`Finance Act loader ${dryRun ? "(dry run) " : ""}— ${file}`);
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

  const { amendments, stats } = parseAmendments(doc.pages);
  console.log(
    `  Extracted ${amendments.length} candidate amendments of ${stats.amendmentMentions} ` +
      `"is amended" mentions; margin column removed on ${stats.pagesWithMarginStripped}/${stats.pagesSeen} pages.`
  );

  if (dryRun) {
    for (const a of amendments.slice(0, 10)) {
      console.log(`  [${a.operation}] ${a.targetSection} — ${a.targetAct}  (p.${a.page})`);
      console.log(`     ${a.text.slice(0, 100)}`);
    }
    console.log("Dry run — nothing written. Amendments are NEVER auto-applied to obligations.");
    return;
  }

  const src = await ensureSourceVersion(
    {
      path: file,
      title: "Finance Act 2026",
      issuer: "Republic of Kenya",
      docType: "C",
      effectiveFrom: EFFECTIVE_FROM,
      sourceFile: "finance-act-2026.pdf", // served from public/docs for deep links
    },
    dryRun
  );
  if (src.alreadyLoaded) {
    console.log(`Already loaded (hash ${src.contentHash.slice(0, 12)}). Nothing to do.`);
    return;
  }

  await prisma.amendment.createMany({
    data: amendments.map((a) => ({
      sourceVersionId: src.sourceVersionId,
      targetAct: a.targetAct,
      targetSection: a.targetSection,
      operation: a.operation,
      text: a.text,
      effectiveFrom: EFFECTIVE_FROM,
      // reviewedBy = null, appliedToObligationId = null -> awaiting human review.
    })),
  });

  // Store the page text as chunks with confidence (skip near-empty pages).
  await prisma.chunk.createMany({
    data: doc.pageText
      .map((text, i) => ({ text, page: i + 1 }))
      .filter((p) => p.text.trim().length > 40)
      .map((p) => ({
        sourceVersionId: src.sourceVersionId,
        sectionRef: `p.${p.page}`,
        text: p.text,
        sourcePage: p.page,
        ocrConfidence: doc.meanOcrConfidence,
      })),
  });

  console.log(`Inserted ${amendments.length} amendments (UNREVIEWED) + page chunks.`);
  console.log("Next step is HUMAN: review the amendments queue and decide obligation changes.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
