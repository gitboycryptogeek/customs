-- Bookkeeping for documents a user adds, plus the staging tables that keep
-- parser output away from the live rules until a person approves it.
--
-- Additive only. Rule 3 in CLAUDE.md — sources are append-only — means a
-- migration may add columns and tables but must never rewrite or drop a row.

ALTER TABLE "source_versions" ADD COLUMN "storedPath" TEXT;
--;
ALTER TABLE "source_versions" ADD COLUMN "originalFilename" TEXT;
--;
ALTER TABLE "source_versions" ADD COLUMN "pageCount" INTEGER;
--;
ALTER TABLE "source_versions" ADD COLUMN "ingestStatus" TEXT NOT NULL DEFAULT 'ready';
--;
ALTER TABLE "source_versions" ADD COLUMN "ingestError" TEXT;
--;
ALTER TABLE "source_versions" ADD COLUMN "meanOcrConfidence" REAL;
--;
ALTER TABLE "source_versions" ADD COLUMN "addedBy" TEXT;
--;
CREATE TABLE IF NOT EXISTS "staged_rows" (
  "id"              TEXT PRIMARY KEY NOT NULL,
  "sourceVersionId" TEXT NOT NULL,
  "kind"            TEXT NOT NULL,
  "payload"         TEXT NOT NULL,
  "snippet"         TEXT NOT NULL,
  "sourcePage"      INTEGER,
  "confidence"      REAL NOT NULL DEFAULT 0,
  "parserId"        TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'pending',
  "reviewedBy"      TEXT,
  "reviewedAt"      DATETIME,
  "producedId"      TEXT,
  "createdAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staged_rows_sourceVersionId_fkey"
    FOREIGN KEY ("sourceVersionId") REFERENCES "source_versions" ("id")
);
--;
CREATE INDEX IF NOT EXISTS "staged_rows_sourceVersionId_idx" ON "staged_rows" ("sourceVersionId");
--;
CREATE INDEX IF NOT EXISTS "staged_rows_status_idx" ON "staged_rows" ("status");
--;
CREATE TABLE IF NOT EXISTS "parse_runs" (
  "id"              TEXT PRIMARY KEY NOT NULL,
  "sourceVersionId" TEXT NOT NULL,
  "parserId"        TEXT NOT NULL,
  "linesSeen"       INTEGER NOT NULL,
  "rowsMatched"     INTEGER NOT NULL,
  "coveragePct"     REAL NOT NULL,
  "notes"           TEXT,
  "ranAt"           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "parse_runs_sourceVersionId_fkey"
    FOREIGN KEY ("sourceVersionId") REFERENCES "source_versions" ("id")
);
--;
CREATE INDEX IF NOT EXISTS "parse_runs_sourceVersionId_idx" ON "parse_runs" ("sourceVersionId");
--;
-- These three only start to matter past a handful of documents, but they are
-- what stops descriptionFor() and the chunk lookups becoming full table scans.
CREATE INDEX IF NOT EXISTS "chunks_sectionRef_idx" ON "chunks" ("sectionRef");
--;
CREATE INDEX IF NOT EXISTS "chunks_sourceVersionId_idx" ON "chunks" ("sourceVersionId");
--;
CREATE INDEX IF NOT EXISTS "obligations_hsPrefix_type_idx" ON "obligations" ("hsPrefix", "type");
