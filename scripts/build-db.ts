/**
 * Build the shipped database from the four published-law PDFs in public/docs/.
 *
 * This is the only way prisma/customs.db comes into existence. It used to be a
 * committed file, which made one artifact serve as build output, test fixture and
 * the app's live dev database at once — so a document ingested through the
 * Documents page ended up staged for a public commit. Now it is a build output,
 * git-ignored, and verified against fixtures/baseline.json.
 *
 *   npm run db:build            # writes prisma/customs.db (refuses to clobber)
 *   npm run db:build -- --force # rebuild over an existing one
 *
 * Takes roughly 5-10 minutes: the CET is 577 text pages, and the Finance Act and
 * Routine Order are scans, ~111 pages of OCR at two to four seconds a page.
 * `npm run db:fetch` pulls the prebuilt one from the latest release instead.
 */
import { execFileSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const TARGET = resolve("prisma/customs.db");
const SCRATCH = resolve("prisma/customs.build.db");
const force = process.argv.includes("--force");

if (existsSync(TARGET) && !force) {
  console.error(`${TARGET} already exists.`);
  console.error("");
  console.error("Rebuilding replaces it, and any documents you added through the");
  console.error("Documents page live in it — they are not recoverable from the PDFs");
  console.error("in docs-store/ without re-adding them in the app.");
  console.error("");
  console.error("Re-run with --force if that is what you want:  npm run db:build -- --force");
  process.exit(1);
}

/** Every step runs against the scratch file, so a failure leaves no half-built database. */
const env = { ...process.env, DB_PROVIDER: "sqlite", DATABASE_URL: `file:${SCRATCH}` };

function run(label: string, args: string[]) {
  console.log(`\n--- ${label}`);
  execFileSync("npx", args, { stdio: "inherit", env, shell: process.platform === "win32" });
}

rmSync(SCRATCH, { force: true });

run("schema: select sqlite + generate client", ["tsx", "scripts/select-schema.ts", "sqlite"]);
run("schema: create tables", [
  "prisma",
  "db",
  "push",
  "--schema",
  "prisma/schema.prisma",
  "--skip-generate",
  "--accept-data-loss",
]);
// The FTS5 index and the ordered SQL in prisma/app-migrations/ — the schema alone
// does not create either, and search falls back to a full scan without the index.
run("schema: app migrations + full-text index", ["tsx", "scripts/migrate.ts"]);

run("load: EAC Common External Tariff", ["tsx", "scripts/load-cet.ts", "public/docs/cet.pdf"]);
run("load: Miscellaneous Fees and Levies Act", [
  "tsx",
  "scripts/load-misc-levies.ts",
  "public/docs/misc-fees-and-levies.pdf",
]);
run("load: Finance Act 2026 (scanned, OCR)", [
  "tsx",
  "scripts/load-finance-act.ts",
  "public/docs/finance-act-2026.pdf",
]);
run("load: EAC Gazette Routine Order No.2 (scanned, OCR)", [
  "tsx",
  "scripts/load-routine-order.ts",
  "public/docs/routine-order-2026.pdf",
]);
run("seed: HS code shortcuts", ["tsx", "scripts/seed-aliases.ts"]);

// Gate before the file is promoted: a database that does not reproduce the
// hand-verified rows is not one to ship, and not one to leave lying around
// looking like the real thing.
console.log("\n--- verify: against fixtures/baseline.json");
execFileSync("npx", ["tsx", "scripts/compare-load.ts", SCRATCH], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

rmSync(TARGET, { force: true });
renameSync(SCRATCH, TARGET);
// Prisma's WAL sidecars belong to the scratch path, not the promoted database.
for (const suffix of ["-journal", "-shm", "-wal"]) rmSync(SCRATCH + suffix, { force: true });

console.log(`\nDatabase built: ${TARGET}`);
