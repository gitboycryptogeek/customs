/**
 * Apply pending app migrations to the database in DATABASE_URL.
 *
 * The app does this itself at startup; this is the same code, runnable from a
 * terminal for a seed database or for debugging.
 *
 *   DATABASE_URL="file:./prisma/customs.db" npx tsx scripts/migrate.ts
 */
import { migrate } from "../lib/migrate";
import { prisma } from "../lib/db";

async function main() {
  const result = await migrate();
  console.log(`applied : ${result.applied.length ? result.applied.join(", ") : "(none)"}`);
  console.log(`skipped : ${result.skipped.length ? result.skipped.join(", ") : "(none)"}`);
  console.log(`full-text search: ${result.ftsAvailable ? "available" : "UNAVAILABLE (falling back to scan)"}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
