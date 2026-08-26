-- Deep-link support for "search the law": which page each chunk of text came from.
ALTER TABLE "chunks" ADD COLUMN "sourcePage" INTEGER;
