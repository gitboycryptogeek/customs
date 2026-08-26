// Which database engine the app is talking to. Read once from DB_PROVIDER.
// "postgres" uses tsvector full-text search; "sqlite" uses a tokenised LIKE
// scan (see lib/search.ts). Defaults to postgres.
export type DbProvider = "postgres" | "sqlite";

export function dbProvider(): DbProvider {
  const p = (process.env.DB_PROVIDER || "postgres").toLowerCase();
  return p === "sqlite" ? "sqlite" : "postgres";
}
