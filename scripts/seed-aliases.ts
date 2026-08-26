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

  // Vehicles (heading 87.03/87.04/87.02). A bare "car" is genuinely ambiguous —
  // the exact subheading depends on fuel and engine capacity — so these resolve
  // to the most common *representative* line (petrol saloon 1500–3000cc,
  // assembled = 8703.23.90). The cited code is what drives the rate, so a tester
  // refines it by entering the precise HS code; this just stops "car" landing on
  // an unrelated full-text match. All codes verified present in the loaded CET.
  { term: "car", hsCode: "8703.23.90" },
  { term: "motor vehicle", hsCode: "8703.23.90" },
  { term: "saloon car", hsCode: "8703.23.90" },
  { term: "sedan", hsCode: "8703.23.90" },
  { term: "station wagon", hsCode: "8703.23.90" },
  { term: "suv", hsCode: "8703.24.90" },
  { term: "diesel car", hsCode: "8703.32.90" },
  { term: "pickup", hsCode: "8704.21.90" },
  { term: "pick-up", hsCode: "8704.21.90" },
  { term: "truck", hsCode: "8704.22.90" },
  { term: "lorry", hsCode: "8704.22.90" },
  { term: "bus", hsCode: "8702.10.19" },
  { term: "minibus", hsCode: "8702.10.19" },
  { term: "matatu", hsCode: "8702.10.19" },
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
