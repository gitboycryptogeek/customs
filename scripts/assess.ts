/**
 * CLI: assess a lookup end to end (resolve -> assess -> print).
 *   npx tsx scripts/assess.ts 8471.30.00 150000 private
 *   npx tsx scripts/assess.ts "laptop" 150000 company
 */
import { prisma } from "../lib/db";
import { assess } from "../lib/assess";
import { resolveHsCode } from "../lib/search";
import { interpret } from "../lib/interpret";
import { levyLabel } from "../lib/labels";

function fmt(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: tsx scripts/assess.ts "<hs code or term>" <customsValue> [importerType]');
    console.error('   or: tsx scripts/assess.ts "importing a laptop worth 150000 for my company"');
    process.exit(1);
  }

  // Structured form: "<query> <number> [importerType]". Otherwise treat the whole
  // input as a plain-English sentence and interpret it.
  let query: string;
  let customsValue: number | null;
  let importerType: string;

  if (args.length >= 2 && Number.isFinite(Number(args[1]))) {
    query = args[0];
    customsValue = Number(args[1]);
    importerType = args[2] || "private";
  } else {
    const said = interpret(args.join(" "));
    query = said.itemQuery;
    customsValue = said.customsValue;
    importerType = said.importerType;
    console.log(
      `Understood: "${said.itemQuery}"` +
        ` · value ${said.customsValue === null ? "(not given)" : "KES " + fmt(said.customsValue)}` +
        ` · importer ${said.importerType}${said.importerExplicit ? "" : " (assumed)"}\n`
    );
    if (customsValue === null) {
      console.log("I couldn't find a value in that sentence. Add an amount, e.g. \"…worth 150000\".");
      return;
    }
  }

  const res = await resolveHsCode(query);
  if (!res.hsCode) {
    console.log(`No HS code matched "${query}". Logged to search_misses (the alias-table backlog).`);
    return;
  }
  console.log(`Matched "${query}" -> ${res.hsCode} (via ${res.method})`);
  if (res.description) console.log(`  ${res.description}`);

  const a = await assess(res.hsCode, customsValue, importerType);

  console.log("\nIn plain English");
  console.log("─".repeat(72));
  for (const s of a.plainSummary) console.log(`  ${s}`);

  console.log(`\nBreakdown (rules as at ${a.rulesAsAt.toISOString().slice(0, 10)}), importer: ${importerType}`);
  console.log("─".repeat(72));
  for (const l of a.lines) {
    const rate = l.rate === null ? "  ?  " : `${(l.rate * 100).toFixed(1)}%`.padStart(6);
    const ref = l.page ? `${l.legalRef} (p.${l.page})` : l.legalRef;
    console.log(
      `  ${levyLabel(l.type).padEnd(28)} ${rate}  KES ${fmt(l.amount).padStart(14)}  ${l.needsReview ? "[REVIEW] " : ""}${ref}`
    );
  }
  console.log("─".repeat(72));
  console.log(`  ${"TOTAL".padEnd(28)}        KES ${a.total === null ? "—  (see notes below)" : fmt(a.total).padStart(14)}`);

  if (a.conditions.length) {
    console.log("\nConditions to check:");
    for (const c of a.conditions) {
      const ref = c.page ? `${c.legalRef}, p.${c.page}` : c.legalRef;
      console.log(`  • [${c.type}] ${c.detail}  (${ref})`);
    }
  }
  if (a.flags.length) {
    console.log("\nNotes:");
    for (const f of a.flags) console.log(`  ⚑ [${f.severity}] ${f.message}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
