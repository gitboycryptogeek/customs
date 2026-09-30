-- The audit record for AI-drafted briefings.
--
-- The briefing is narration over assess() output — the model never picks a rate
-- (CLAUDE.md rule 1). This table is what makes that claim checkable later rather
-- than merely asserted: it stores the evidence pack exactly as it was sent, the
-- briefing exactly as it came back, and the result of checking every figure in
-- the second against the first (lib/ai/verify.ts).
--
-- Additive, and the feature is off until somebody configures a key, so an
-- existing database gains an empty table and behaves exactly as before.
--
-- Append-only like every other table here: rows are inserted and never updated
-- or deleted. A briefing is the record of what an officer was shown on a day.

CREATE TABLE IF NOT EXISTS "ai_reports" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "requestedBy"  TEXT,
  "hsCode"       TEXT NOT NULL,
  "itemQuery"    TEXT NOT NULL,
  "customsValue" DECIMAL NOT NULL,
  "importerType" TEXT NOT NULL,
  "model"        TEXT NOT NULL,
  "evidence"     TEXT NOT NULL,
  "report"       TEXT NOT NULL,
  "verified"     BOOLEAN NOT NULL,
  "unsupported"  TEXT NOT NULL,
  "inputTokens"  INTEGER,
  "outputTokens" INTEGER,
  "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--;

CREATE INDEX IF NOT EXISTS "ai_reports_createdAt_idx" ON "ai_reports" ("createdAt");
