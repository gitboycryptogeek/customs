import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { extractDocument } from "../lib/pdf";
import { classify } from "../lib/ingest/classify";

const EXPECTED: Record<string, string> = {
  "cet.pdf": "A",
  "misc-fees-and-levies.pdf": "D",
  "finance-act-2026.pdf": "C",
  "routine-order-2026.pdf": "D",
};

async function main() {
  // Default to the built database as a text cache. Without it this re-OCRs 111
  // scanned pages to check a classifier, which is eight minutes to learn nothing
  // new — the text is already there. It is a build output, so on a fresh clone it
  // legitimately does not exist yet; fall back to reading the PDFs rather than
  // failing, and say which path was taken.
  const cache = process.argv[2] ?? "prisma/customs.db";
  const haveCache = existsSync(cache);
  if (!haveCache) {
    console.log(`no text cache at ${cache} — extracting from the PDFs (slow; run "npm run db:fetch" to skip)
`);
  }
  const db = haveCache ? new DatabaseSync(cache, { readOnly: true }) : null;
  let ok = true;

  for (const [file, want] of Object.entries(EXPECTED)) {
    let pageText: string[];
    let scanned: boolean;

    // Reuse text already extracted for the scanned documents; re-OCRing 111
    // pages to check a classifier is not a good use of ten minutes.
    const cached = db
      ? (db
          .prepare(
            `SELECT c.text AS text FROM chunks c
               JOIN source_versions s ON s.id = c.sourceVersionId
              WHERE s.sourceFile = ? AND c.sectionRef LIKE 'p.%'
              ORDER BY c.sourcePage`
          )
          .all(file) as { text: string }[])
      : [];

    if (cached.length > 0) {
      pageText = cached.map((r) => r.text);
      scanned = true;
    } else {
      const doc = await extractDocument(`public/docs/${file}`);
      pageText = doc.pageText;
      scanned = doc.method === "ocr";
    }

    const c = classify(pageText, scanned);
    const pass = c.docType === want;
    if (!pass) ok = false;
    console.log(`${pass ? "PASS" : "FAIL"}  ${file.padEnd(26)} -> ${c.docType} (expected ${want})`);
    console.log(`      ${c.reason}`);
  }
  console.log(ok ? "\nclassifier: all four correct" : "\nclassifier: MISCLASSIFIED");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
