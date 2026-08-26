/**
 * One command to prepare the database for the configured provider:
 *   - selects the right Prisma schema + generates the client
 *   - Postgres: applies migrations (`prisma migrate deploy`) — keeps the
 *     generated tsvector column + GIN index that full-text search needs.
 *   - SQLite:   creates the tables from the schema (`prisma db push`).
 *
 * Usage:  npx tsx scripts/db-setup.ts   (reads DB_PROVIDER from .env/env)
 */
import { execFileSync } from "node:child_process";
import { resolveProvider } from "./select-schema";

function run(cmd: string, args: string[]) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit" });
}

const provider = resolveProvider();
run("npx", ["tsx", "scripts/select-schema.ts", provider]);

if (provider === "postgres") {
  run("npx", ["prisma", "migrate", "deploy"]);
} else {
  // SQLite: no tsvector/generated columns, so a plain schema push is enough.
  run("npx", ["prisma", "db", "push", "--skip-generate"]);
}
console.log(`Database ready (${provider}).`);
