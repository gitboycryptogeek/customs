/**
 * Fail early, and usefully, when prisma/customs.db is missing.
 *
 * The database is a build output rather than a committed file, so a fresh clone
 * has none. Without this, `next build` prerenders a page, Prisma cannot open the
 * file, and the first thing you see is a stack trace about a table that does not
 * exist — which reads like a schema bug rather than a missing step.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DB = resolve("prisma/customs.db");

if (!existsSync(DB)) {
  console.error("");
  console.error(`No database at ${DB}`);
  console.error("");
  console.error("It is built from the PDFs in public/docs/, not committed. Either:");
  console.error("");
  console.error("  npm run db:fetch     # download the one CI built (seconds)");
  console.error("  npm run db:build     # build it here (5-10 min; 111 pages of OCR)");
  console.error("");
  process.exit(1);
}
