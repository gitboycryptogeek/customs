-- A record of what was looked up.
--
-- `search_misses` already logs the queries that resolved to nothing, because
-- that log is the backlog for the alias table. Nothing logged the ones that
-- worked, so there was no way for an officer to answer "what did I assess an
-- hour ago?" — every assessment vanished the moment the next one replaced it on
-- screen.
--
-- This is deliberately NOT an audit trail of declarations, and must not become
-- one. It holds what `/api/assess` already accepts and nothing more: the
-- redacted item phrase, the value, the importer type, and what the engine
-- resolved it to. No trader name, no PIN, no entry number — the same rule the
-- assess endpoint itself is under.
--
-- `total` is nullable and means what it means everywhere else in this system:
-- null is a total the engine refused to produce because a contributing line
-- needed review. Storing 0 there would turn "we do not know" into "nothing to
-- pay", which is the one substitution this codebase never makes.

CREATE TABLE IF NOT EXISTS "lookups" (
  "id"            TEXT PRIMARY KEY NOT NULL,
  "itemQuery"     TEXT NOT NULL,
  "hsCode"        TEXT,
  "description"   TEXT,
  "resolvedVia"   TEXT,
  "customsValue"  DECIMAL,
  "importerType"  TEXT NOT NULL,
  "total"         DECIMAL,
  "totalBlocked"  BOOLEAN NOT NULL DEFAULT 0,
  "lineCount"     INTEGER NOT NULL DEFAULT 0,
  "flagCount"     INTEGER NOT NULL DEFAULT 0,
  "requestedBy"   TEXT,
  "createdAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--;

-- The list is always drawn newest-first and is the only way this table is read.
CREATE INDEX IF NOT EXISTS "lookups_createdAt_idx" ON "lookups" ("createdAt" DESC);
