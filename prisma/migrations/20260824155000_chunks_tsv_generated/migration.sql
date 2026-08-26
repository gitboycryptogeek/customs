-- Replace Prisma's plain tsv column with a generated tsvector + GIN index.
-- Prisma can't express GENERATED ALWAYS AS; it only knows tsv as Unsupported.
ALTER TABLE "chunks" DROP COLUMN IF EXISTS "tsv";
ALTER TABLE "chunks" ADD COLUMN "tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED;
CREATE INDEX IF NOT EXISTS "chunks_tsv_idx" ON "chunks" USING GIN ("tsv");
