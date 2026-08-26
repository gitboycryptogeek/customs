/**
 * Pick the Prisma schema variant for the configured database and generate the
 * client. Prisma can't switch `provider` at runtime, so we keep two source-of-
 * truth schemas (schema.postgres.prisma / schema.sqlite.prisma) and copy the one
 * that matches DB_PROVIDER onto the generated prisma/schema.prisma.
 *
 *   DB_PROVIDER=postgres  (default)  -> Postgres + tsvector full-text search
 *   DB_PROVIDER=sqlite               -> single-file SQLite, no server needed
 *
 * Usage:  npx tsx scripts/select-schema.ts        (reads DB_PROVIDER from .env/env)
 *         npx tsx scripts/select-schema.ts sqlite  (explicit override)
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** DB_PROVIDER from the process env, falling back to the .env file, default postgres. */
export function resolveProvider(argv: string[] = []): "postgres" | "sqlite" {
  const explicit = argv.find((a) => a === "postgres" || a === "sqlite");
  if (explicit) return explicit as "postgres" | "sqlite";

  let val = process.env.DB_PROVIDER;
  if (!val) {
    const envPath = join(process.cwd(), ".env");
    if (existsSync(envPath)) {
      const m = readFileSync(envPath, "utf8").match(/^\s*DB_PROVIDER\s*=\s*["']?(\w+)/m);
      if (m) val = m[1];
    }
  }
  const p = (val || "postgres").toLowerCase();
  if (p !== "postgres" && p !== "sqlite") {
    throw new Error(`DB_PROVIDER must be "postgres" or "sqlite", got "${val}"`);
  }
  return p;
}

function main() {
  const provider = resolveProvider(process.argv.slice(2));
  const prismaDir = join(process.cwd(), "prisma");
  const variant = join(prismaDir, `schema.${provider}.prisma`);
  const active = join(prismaDir, "schema.prisma");
  if (!existsSync(variant)) throw new Error(`Missing schema variant: ${variant}`);

  copyFileSync(variant, active);
  console.log(`Selected ${provider} schema -> prisma/schema.prisma`);
  execFileSync("npx", ["prisma", "generate"], { stdio: "inherit" });
}

// Only run when invoked directly (not when imported by other scripts).
if (process.argv[1] && process.argv[1].endsWith("select-schema.ts")) {
  main();
}
