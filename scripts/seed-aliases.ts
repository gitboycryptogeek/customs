/**
 * Seed the alias table with common trade terms -> HS codes.
 * Aliases are the #2 resolution step (after exact code, before full-text).
 * The search_misses log is the backlog for growing this table — review weekly.
 */
import { prisma } from "../lib/db";

const ALIASES: { term: string; hsCode: string }[] = [
  { term: "laptop", hsCode: "8471.30.00" },
  { term: "notebook pc", hsCode: "8471.30.00" },
  { term: "macbook", hsCode: "8471.30.00" },
  { term: "portable computer", hsCode: "8471.30.00" },
  { term: "desktop computer", hsCode: "8471.50.00" },
  { term: "mobile phone", hsCode: "8517.13.00" },
  { term: "smartphone", hsCode: "8517.13.00" },
  { term: "cement", hsCode: "2523.29.00" },
  { term: "portland cement", hsCode: "2523.29.00" },
  { term: "motorcycle", hsCode: "8711.60.00" },
  { term: "electric motorcycle", hsCode: "8711.60.00" },
  { term: "rice", hsCode: "1006.30.00" },
];

async function main() {
  let n = 0;
  for (const a of ALIASES) {
    await prisma.alias.upsert({
      where: { term: a.term },
      update: { hsCode: a.hsCode },
      create: { term: a.term, hsCode: a.hsCode, addedBy: "seed" },
    });
    n++;
  }
  console.log(`Seeded ${n} aliases.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
