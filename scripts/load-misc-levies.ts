/**
 * Miscellaneous Fees and Levies Act (Cap. 469C) — text-layer statute.
 * Unlike the CET this is prose, but it carries two flat, ad-valorem levies that
 * apply to (almost) every import for home use. We load them as global
 * obligations (hsPrefix = "" -> longest-prefix-match falls through to them):
 *
 *   IDF  Import Declaration Fee   2.5% of customs value   s.7(2)
 *   RDL  Railway Development Levy 2%   of customs value    s.8(2)
 *
 * The First/Third Schedules (export levy, export & investment promotion levy)
 * are HS-specific and export-side; not loaded as import obligations here.
 * Full text is chunked for search. Second Schedule Part A (IDF exemptions) is
 * recorded as a condition pointer for human review, not auto-applied.
 *
 * Usage:  npx tsx scripts/load-misc-levies.ts ./Miscellaneous*.pdf [--dry-run]
 */
import { prisma } from "../lib/db";
import { extractPages, hasTextLayer } from "./lib/pdf";
import { layoutPages } from "../lib/pdf";
import { chunkDocument } from "../lib/ingest/chunker";
import { ensureSourceVersion, parseArgs } from "./lib/source";

const EFFECTIVE_FROM = new Date("2024-12-27"); // "Legislation as at 27 December 2024"

/** First 1-based page whose text matches `re`, or null. For deep-linking a section. */
function findPage(pages: string[], re: RegExp): number | null {
  for (let i = 0; i < pages.length; i++) if (re.test(pages[i])) return i + 1;
  return null;
}

async function main() {
  const { file, dryRun } = parseArgs(process.argv);
  if (!file) {
    console.error("usage: tsx scripts/load-misc-levies.ts <file.pdf> [--dry-run]");
    process.exit(1);
  }
  if (!(await hasTextLayer(file))) {
    console.error("No text layer — expected the Kenya Law text PDF of Cap. 469C.");
    process.exit(1);
  }

  const src = await ensureSourceVersion(
    {
      path: file,
      title: "Miscellaneous Fees and Levies Act (Cap. 469C), as at 27 Dec 2024",
      issuer: "Republic of Kenya",
      docType: "D",
      effectiveFrom: EFFECTIVE_FROM,
      sourceFile: "misc-fees-and-levies.pdf", // served from public/docs for deep links
    },
    dryRun
  );

  // Best-effort page of each levy's defining section, for deep links. Match the
  // levy name (more robust than a bare section number); null if not found.
  const pdfPages = await extractPages(file);
  const pages = layoutPages(pdfPages);
  const idfPage = findPage(pages, /import\s+declaration\s+fee/i);
  const rdlPage = findPage(pages, /railway\s+development\s+levy/i);

  const obligations = [
    {
      type: "idf",
      rate: 0.025,
      basis: "customs_value",
      legalRef: "Misc Fees & Levies Act (Cap. 469C) s.7(2)",
      sourcePage: idfPage,
      note: "Import declaration fee — 2.5% of customs value on goods for home use.",
    },
    {
      type: "rdl",
      rate: 0.02,
      basis: "customs_value",
      legalRef: "Misc Fees & Levies Act (Cap. 469C) s.8(2)",
      sourcePage: rdlPage,
      note: "Railway development levy — 2% of customs value on goods for home use.",
    },
  ];

  const conditions = [
    {
      conditionType: "exemption",
      detail:
        "IDF is not charged on goods specified in Part A of the Second Schedule (s.7(3)(a)). Verify the specific item against that schedule.",
      legalRef: "Misc Fees & Levies Act (Cap. 469C) s.7(3)(a), Second Schedule Part A",
    },
    {
      conditionType: "exemption",
      detail:
        "Export & investment promotion levy (s.7A) applies only to Third Schedule goods and not to EAC-origin goods meeting Rules of Origin.",
      legalRef: "Misc Fees & Levies Act (Cap. 469C) s.7A, Third Schedule",
    },
  ];

  console.log(`Misc Levies loader ${dryRun ? "(dry run) " : ""}— ${file}`);
  console.log(`  Global obligations to load: ${obligations.map((o) => o.type.toUpperCase()).join(", ")}`);
  console.log(`  Conditions (review pointers): ${conditions.length}`);

  if (dryRun) {
    for (const o of obligations) console.log(`  ${o.type.toUpperCase()} ${o.rate * 100}%  ${o.legalRef}`);
    return;
  }
  if (src.alreadyLoaded) {
    console.log(`Already loaded (hash ${src.contentHash.slice(0, 12)}). Nothing to do.`);
    return;
  }

  await prisma.obligation.createMany({
    data: obligations.map((o) => ({
      sourceVersionId: src.sourceVersionId,
      hsPrefix: "", // global — applies to all imports for home use
      type: o.type,
      rate: o.rate,
      basis: o.basis,
      legalRef: o.legalRef,
      sourcePage: o.sourcePage,
      needsReview: false,
      effectiveFrom: EFFECTIVE_FROM,
    })),
  });

  await prisma.condition.createMany({
    data: conditions.map((c) => ({
      sourceVersionId: src.sourceVersionId,
      hsPrefix: "",
      conditionType: c.conditionType,
      detail: c.detail,
      legalRef: c.legalRef,
      effectiveFrom: EFFECTIVE_FROM,
    })),
  });

  // Chunk by paragraph, not by page: a search hit should return the provision
  // somebody was looking for, with the page it came from attached.
  const paras = chunkDocument(pdfPages, pages);
  const CHUNK = 500;
  for (let i = 0; i < paras.length; i += CHUNK) {
    await prisma.chunk.createMany({
      data: paras.slice(i, i + CHUNK).map((p) => ({
        sourceVersionId: src.sourceVersionId,
        sectionRef: "Cap.469C",
        text: p.text,
        sourcePage: p.page,
      })),
    });
  }

  console.log(`Inserted ${obligations.length} obligations, ${conditions.length} conditions, ${paras.length} chunks.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
