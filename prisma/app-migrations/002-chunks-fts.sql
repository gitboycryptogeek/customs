-- Full-text search over every chunk.
--
-- searchLaw() previously pulled EVERY chunk into memory and scored it in JS.
-- At four documents that is 6,000 rows and fine; the moment a user adds a
-- hundred more it is hundreds of thousands, and the request dies. FTS5 is
-- compiled into the SQLite that ships with Prisma, is deterministic (bm25 is a
-- pure function of the index), and needs no extension to be installed.
--
-- External-content table: the index stores no copy of the text, it points at
-- "chunks". Triggers keep the two in step.

CREATE VIRTUAL TABLE IF NOT EXISTS "chunks_fts" USING fts5(
  text,
  content = 'chunks',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);
--;
CREATE TRIGGER IF NOT EXISTS "chunks_fts_ai" AFTER INSERT ON "chunks" BEGIN
  INSERT INTO "chunks_fts"(rowid, text) VALUES (new.rowid, new.text);
END;
--;
CREATE TRIGGER IF NOT EXISTS "chunks_fts_ad" AFTER DELETE ON "chunks" BEGIN
  INSERT INTO "chunks_fts"("chunks_fts", rowid, text) VALUES ('delete', old.rowid, old.text);
END;
--;
CREATE TRIGGER IF NOT EXISTS "chunks_fts_au" AFTER UPDATE ON "chunks" BEGIN
  INSERT INTO "chunks_fts"("chunks_fts", rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO "chunks_fts"(rowid, text) VALUES (new.rowid, new.text);
END;
--;
-- Index whatever is already there. 'rebuild' is idempotent, so re-running this
-- migration on a populated database is harmless.
INSERT INTO "chunks_fts"("chunks_fts") VALUES ('rebuild');
