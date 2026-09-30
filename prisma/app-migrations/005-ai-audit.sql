-- Audit mode: the AI querying the database rather than being handed a pack.
--
-- The quick briefing restates a finished assessment. An audit goes looking for
-- what the assessment could not show — a second obligation row longest-prefix
-- match discarded, an unapplied Finance Act amendment, a pending staged row, a
-- superseded source. That means the model issues queries, and these columns are
-- what make the result checkable afterwards:
--
--   toolCalls        every query it ran and what came back. In audit mode this
--                    IS the evidence pack — a finding is only admissible if it
--                    cites a row that appears here.
--   findings         the findings that survived that citation check.
--   droppedFindings  the ones that did not. Kept deliberately: a model citing
--                    row ids no query returned is precisely the failure this
--                    table exists to make visible, and deleting the evidence of
--                    it would defeat the point.
--   proposalsCreated how many staged rows this audit put in the human review
--                    queue. Those go to `staged_rows`, never to `obligations`.
--
-- Additive and nullable, so a database holding briefings from before this
-- feature keeps them and reads them as mode='brief', which is what they were.

ALTER TABLE "ai_reports" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'brief';

--;

ALTER TABLE "ai_reports" ADD COLUMN "toolCalls" TEXT;

--;

ALTER TABLE "ai_reports" ADD COLUMN "findings" TEXT;

--;

ALTER TABLE "ai_reports" ADD COLUMN "droppedFindings" TEXT;

--;

ALTER TABLE "ai_reports" ADD COLUMN "proposalsCreated" INTEGER NOT NULL DEFAULT 0;
