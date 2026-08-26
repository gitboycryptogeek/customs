-- Deep-link support: which PDF and which page each figure came from.
ALTER TABLE "source_versions" ADD COLUMN "sourceFile" TEXT;
ALTER TABLE "obligations" ADD COLUMN "sourcePage" INTEGER;
ALTER TABLE "conditions" ADD COLUMN "sourcePage" INTEGER;
