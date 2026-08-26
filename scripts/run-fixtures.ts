/**
 * Regression harness. Runs every hand-verified case in fixtures/known-cases.json
 * end to end (resolve -> assess) and diffs against expected values.
 *
 * When a new Finance Act loads and three fixtures shift, this tells you instantly
 * whether the LAW changed or your PARSER broke. Run after every change.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../lib/db";
import { assess } from "../lib/assess";
import { resolveHsCode } from "../lib/search";

interface Fixture {
  name: string;
  query: string;
  customsValue: number;
  importerType: string;
  expect: {
    hsCode: string | null;
    method?: string;
    lines?: Record<string, number>;
    total?: number | null;
    blocked?: boolean;
    flagIncludes?: string;
    legalRefIncludes?: string;
  };
}

function approx(a: number, b: number) {
  return Math.abs(a - b) < 0.01;
}

async function main() {
  const fixtures: Fixture[] = JSON.parse(
    readFileSync(join(process.cwd(), "fixtures/known-cases.json"), "utf8")
  );
  let pass = 0;
  const failures: string[] = [];

  for (const fx of fixtures) {
    const errs: string[] = [];
    const res = await resolveHsCode(fx.query);

    if ((res.hsCode ?? null) !== (fx.expect.hsCode ?? null))
      errs.push(`hsCode: got ${res.hsCode} want ${fx.expect.hsCode}`);
    if (fx.expect.method && res.method !== fx.expect.method)
      errs.push(`method: got ${res.method} want ${fx.expect.method}`);

    if (fx.expect.hsCode && res.hsCode) {
      const a = await assess(res.hsCode, fx.customsValue, fx.importerType);

      if (fx.expect.lines) {
        for (const [type, amt] of Object.entries(fx.expect.lines)) {
          const line = a.lines.find((l) => l.type === type);
          if (!line) errs.push(`line ${type}: missing`);
          else if (line.amount === null || !approx(line.amount, amt))
            errs.push(`line ${type}: got ${line.amount} want ${amt}`);
        }
      }
      if ("total" in fx.expect) {
        const wantNull = fx.expect.total === null;
        if (wantNull && a.total !== null) errs.push(`total: got ${a.total} want null (blocked)`);
        if (!wantNull && (a.total === null || !approx(a.total, fx.expect.total as number)))
          errs.push(`total: got ${a.total} want ${fx.expect.total}`);
      }
      if (fx.expect.blocked !== undefined) {
        const isBlocked = a.total === null;
        if (isBlocked !== fx.expect.blocked)
          errs.push(`blocked: got ${isBlocked} want ${fx.expect.blocked}`);
      }
      if (fx.expect.flagIncludes && !a.flags.some((f) => f.message.toLowerCase().includes(fx.expect.flagIncludes!)))
        errs.push(`flag containing "${fx.expect.flagIncludes}" not found`);
      if (fx.expect.legalRefIncludes && !a.lines.some((l) => l.legalRef.includes(fx.expect.legalRefIncludes!)))
        errs.push(`legalRef containing "${fx.expect.legalRefIncludes}" not found`);
    }

    if (errs.length === 0) {
      pass++;
      console.log(`  ✓ ${fx.name}`);
    } else {
      failures.push(fx.name);
      console.log(`  ✗ ${fx.name}`);
      for (const e of errs) console.log(`      - ${e}`);
    }
  }

  console.log(`\n${pass}/${fixtures.length} passed.`);
  if (failures.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
