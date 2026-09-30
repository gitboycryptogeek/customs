-- Where a chunk came from.
--
-- Re-reading a document has to be able to throw away the text the extractor
-- produced and put fresh text in its place. It must NOT throw away the chunks
-- that approval wrote: lib/ingest/review.ts stores an approved obligation's
-- description as a chunk so search can find it by HS prefix, and that one
-- carries a person's decision behind it.
--
-- The two were previously distinguishable only by the shape of `sectionRef`
-- ("p.7" for a page, "8471" for a prefix), which is exactly the kind of
-- implicit coupling that breaks the first time somebody changes a label. This
-- says it outright.
--
-- Additive, and defaulted, so an existing database keeps every chunk it has and
-- calls them all extraction — which they are: before this column existed there
-- was no re-read, so nothing could have been written any other way.

ALTER TABLE "chunks" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'extract';
