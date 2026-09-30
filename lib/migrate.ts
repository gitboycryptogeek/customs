// Bringing an existing database forward, inside the running app.
//
// Every user's database is their own first-launch copy of the shipped
// prisma/customs.db, sitting in a writable per-user folder. When a new version
// adds a column, that copy has to be migrated in place — but `prisma migrate
// deploy` needs the Prisma CLI, and the CLI is not in the packaged bundle.
//
// So migrations ship as ordered SQL under prisma/app-migrations and are applied
// here at server start. They are additive only: rule 3 in CLAUDE.md means a
// migration may add columns and tables, never rewrite or drop a source row.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { prisma } from "./db";
import { dbProvider } from "./provider";

/** Statement separator inside a migration file. */
const SPLIT = /^--;$/m;

/**
 * Errors that mean "this statement has already been applied".
 *
 * A freshly-generated database already has everything migration 001 adds,
 * because `prisma db push` built it from the same schema. Tolerating these
 * keeps one set of migrations correct for both a new install and an upgrade,
 * rather than needing the two to diverge.
 */
const ALREADY_APPLIED = /duplicate column name|already exists/i;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  /** Set when full-text search could not be created; search falls back to a scan. */
  ftsAvailable: boolean;
}

function migrationsDir(): string | null {
  const candidates = [
    process.env.APP_MIGRATIONS_DIR,
    join(process.cwd(), "prisma", "app-migrations"),
    // The Next standalone bundle runs with cwd inside .next/standalone.
    join(process.cwd(), "..", "..", "prisma", "app-migrations"),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
}

let ran: Promise<MigrationResult> | null = null;

/**
 * Apply any pending migrations. Safe to call repeatedly — the work happens once
 * per process, and each migration runs at most once per database.
 */
export function migrate(): Promise<MigrationResult> {
  if (!ran) ran = run();
  return ran;
}

async function run(): Promise<MigrationResult> {
  const result: MigrationResult = { applied: [], skipped: [], ftsAvailable: false };

  // Postgres gets its schema from `prisma migrate`, and already has tsvector
  // full-text search. This path is for the portable SQLite database the desktop
  // app carries.
  if (dbProvider() !== "sqlite") {
    result.ftsAvailable = true;
    return result;
  }

  const dir = migrationsDir();
  if (!dir) {
    console.warn("[migrate] no app-migrations directory found; skipping");
    return result;
  }

  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "_app_migrations" (
       "name" TEXT PRIMARY KEY NOT NULL,
       "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`
  );

  const done = new Set(
    (
      await prisma.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM "_app_migrations"`)
    ).map((r) => r.name)
  );

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) {
      result.skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(dir, file), "utf8");
    const statements = sql
      .split(SPLIT)
      .map((s) => s.trim())
      .filter((s) => s && !s.split("\n").every((l) => l.trim().startsWith("--")));

    try {
      for (const statement of statements) {
        try {
          await prisma.$executeRawUnsafe(statement);
        } catch (err) {
          const message = (err as Error).message ?? "";
          if (ALREADY_APPLIED.test(message)) continue;
          throw err;
        }
      }
      await prisma.$executeRawUnsafe(`INSERT INTO "_app_migrations" ("name") VALUES (?)`, file);
      result.applied.push(file);
      console.log(`[migrate] applied ${file}`);
    } catch (err) {
      // A migration that cannot be applied must not take the app down — the
      // lookup path still works on the old shape. Record it and carry on so the
      // failure is visible without being fatal.
      console.error(`[migrate] ${file} failed:`, (err as Error).message);
    }
  }

  result.ftsAvailable = await hasFts();
  if (!result.ftsAvailable) {
    console.warn("[migrate] full-text index unavailable — search will use the slower scan");
  }
  return result;
}

/** Whether the FTS index exists and is queryable in this SQLite build. */
async function hasFts(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe(`SELECT rowid FROM "chunks_fts" WHERE "chunks_fts" MATCH 'a' LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}
