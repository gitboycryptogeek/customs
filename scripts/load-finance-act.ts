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
 * This particular Finance Act 2026 PDF is a scan (Type B extraction): pdffonts
 * is empty, pdftotext yields ~0 chars. We rasterize (pdftoppm -r 150) and OCR
 * (tesseract), storing ocr_confidence per chunk. Marginal annotations garble —
 * we ignore the margins; body text OCRs cleanly.
 *
 * Usage:  npx tsx scripts/load-finance-act.ts ./Finance*.pdf [--dry-run]
 */
import { prisma } from "../lib/db";
import { ocrPdf, tesseractAvailable, hasTextLayer } from "./lib/pdf";
import { ensureSourceVersion, parseArgs } from "./lib/source";

const EFFECTIVE_FROM = new Date("2026-07-01"); // Finance Act 2026 typical commencement

// Statutory amendment sentence: "Section N of the X Act is amended by <op>ing ..."
const AMENDMENT =
  /Section\s+([0-9]+[A-Z]?(?:\([0-9A-Za-z]+\))?)\s+(?:of\s+the\s+(.+?Act(?:,?\s*\d{4})?)\s+)?is\s+amended\s+by\s+([a-z]+ing)\b([^.]*\.)/gi;

function classifyOperation(word: string): string {
  const w = word.toLowerCase();
  if (w.startsWith("insert") || w.startsWith("add")) return "insert";
  if (w.startsWith("delet") || w.startsWith("repeal")) return "delete";
  if (w.startsWith("substitut") || w.startsWith("replac")) return "substitute";
  return "amend";
}

async function main() {
  const { file, dryRun } = parseArgs(process.argv);
  if (!file) {
    console.error("usage: tsx scripts/load-finance-act.ts <file.pdf> [--dry-run]");
    process.exit(1);
  }
  if (!tesseractAvailable()) {
    console.error(
      "tesseract not installed. Run: sudo apt install -y tesseract-ocr\n" +
        "(This is the only blocker for the two scanned PDFs. See memory/ocr-blocker.md)"
    );
    process.exit(1);
  }

  console.log(`Finance Act loader ${dryRun ? "(dry run) " : ""}— ${file}`);
  console.log(hasTextLayer(file) ? "  (note: text layer present)" : "  Scanned — running OCR (pdftoppm + tesseract)…");

  const pages = ocrPdf(file, 150);
  const fullText = pages.map((p) => p.text).join("\n");
  const meanConf = pages.reduce((s, p) => s + (p.confidence >= 0 ? p.confidence : 0), 0) / pages.length;
  console.log(`  OCR'd ${pages.length} pages, mean confidence ${(meanConf * 100).toFixed(1)}%`);

  // Extract amendment sentences for the review queue.
  const amendments: { targetAct: string; targetSection: string; operation: string; text: string }[] = [];
  for (const m of fullText.matchAll(AMENDMENT)) {
    const section = m[1].trim();
    const act = (m[2] ?? "").trim() || "(unspecified — review)";
    const op = classifyOperation(m[3]);
    const text = `Section ${section}${m[2] ? ` of the ${act}` : ""} is amended by ${m[3]}${m[4]}`
      .replace(/\s+/g, " ")
      .trim();
    amendments.push({ targetAct: act, targetSection: `Section ${section}`, operation: op, text });
  }

  console.log(`  Extracted ${amendments.length} candidate amendments for the review queue.`);
  if (dryRun) {
    for (const a of amendments.slice(0, 10)) {
      console.log(`  [${a.operation}] ${a.targetSection} — ${a.targetAct}`);
      console.log(`     ${a.text.slice(0, 100)}`);
    }
    console.log("Dry run — nothing written. Remember: amendments are NEVER auto-applied to obligations.");
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

  // Store OCR'd pages as chunks with confidence (skip marginal-only garbage pages).
  await prisma.chunk.createMany({
    data: pages
      .filter((p) => p.text.trim().length > 40)
      .map((p) => ({
        sourceVersionId: src.sourceVersionId,
        sectionRef: `p.${p.page}`,
        text: p.text,
        sourcePage: p.page,
        ocrConfidence: p.confidence >= 0 ? p.confidence : null,
      })),
  });

  console.log(`Inserted ${amendments.length} amendments (UNREVIEWED) + ${pages.length} OCR chunks.`);
  console.log("Next step is HUMAN: review the amendments queue and decide obligation changes.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
