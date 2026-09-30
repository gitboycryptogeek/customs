/**
 * Type A loader — EAC Common External Tariff (CET 2022, updated June 2025).
 * Fixed-column schedule with a clean text layer. ~5,700 duty rows in one pass.
 *
 * The parsing itself lives in lib/ingest/parsers/cet.ts so this loader, the
 * in-app ingest pipeline and scripts/verify-parity.ts all run identical code.
 * Two copies would mean two possible answers for one tariff line.
 *
 * Usage:  npx tsx scripts/load-cet.ts ./CET*.pdf [--dry-run]
 */
import { prisma } from "../lib/db";
import { parseCet } from "../lib/ingest/parsers/cet";
import { pdfToPages, hasTextLayer } from "./lib/pdf";
import { ensureSourceVersion, parseArgs } from "./lib/source";

const CET_EFFECTIVE_FROM = new Date("2025-06-01"); // "updated June 2025"

async function main() {
  const { file, dryRun } = parseArgs(process.argv);
  if (!file) {
    console.error("usage: tsx scripts/load-cet.ts <file.pdf> [--dry-run]");
    process.exit(1);
  }
  if (!(await hasTextLayer(file))) {
    console.error("This PDF has no text layer — not a Type A document. Use the OCR path.");
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

  // Layout text, one entry per page: index + 1 is the physical page number,
  // which is what a browser's #page=N deep link expects.
  const pages = await pdfToPages(file);
  const { rows, stats } = parseCet(pages);

  console.log(
    `Parsed: ${stats.matched} duty rows matched of ${stats.hsLinesSeen} HS-code lines seen ` +
      `(${stats.coveragePct.toFixed(1)}%)`
  );
  console.log(
    `  SI markers seen: ${stats.siCount}; resolved via Schedule 2: ${stats.resolvedSI}; ` +
      `still unresolved (rate=null, needs_review): ${stats.unresolvedSI}`
  );
  console.log(`  Compound "higher-of" rates (needs_review): ${stats.compoundCount}`);
  console.log(`  Rows to insert after SI resolution: ${rows.length}`);

  if (dryRun) {
    console.log("Dry run — sample of 8 parsed rows:");
    for (const row of rows.slice(0, 8)) {
      console.log(
        `  ${row.hsPrefix}  rate=${row.rate === null ? "NULL" : row.rate}  ` +
          `${row.needsReview ? "[review] " : ""}${row.description.slice(0, 60)}`
      );
    }
    return;
  }

  // Insert obligations (duty). One row per HS item; description goes in a chunk.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
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
          sourcePage: row.page,
        })),
      }),
    ]);
  }
  console.log(`Inserted ${rows.length} duty obligations + ${rows.length} chunks.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
