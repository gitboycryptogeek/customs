// Removing a document from the library.
//
// This is the one place in the codebase that deletes a source version, and it
// exists against the grain of rule 3 in CLAUDE.md, so it is worth being precise
// about why.
//
// Rule 3 protects a specific thing: a declaration filed in March 2025 must
// still be assessable against the rules in force in March 2025. That is why a
// tariff is never overwritten and never deleted — it is superseded, its rows
// keep their dates, and history stays answerable. None of that reasoning covers
// the case this function is for: a user loaded the wrong PDF, or loaded the
// right one with the wrong commencement date, and wants it gone. Keeping that
// document forever does not protect anybody's audit trail; it just leaves a
// wrong document in the library where an officer can cite it.
//
// So removal is real and complete — the row, everything derived from it, and
// the stored file — and the caller has to have seen what it will destroy. Two
// things it will not do:
//
//   - It refuses when another version records this one as its predecessor.
//     That link is what says "this tariff replaced that tariff", and breaking
//     it silently rewrites the history rule 3 is there to keep.
//   - It never deletes a file out of the app bundle. Those four documents ship
//     with the app, the bundle is read-only, and a user who removes one from
//     the library can re-add it.
//
// What it emphatically is NOT is a way to retire a superseded tariff. That is
// `supersede()` in ./source.ts, which closes the old version's window and keeps
// every row. If the document has ever produced a rule somebody approved, the
// caller is told so before it goes, in those words.

import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

import { prisma } from "../db";
import { docsDir } from "./store";

/** What removing a document would destroy. Shown to a person before it happens. */
export interface RemovalPreview {
  id: string;
  title: string;
  /** Rules an officer could be citing today. The number that should give pause. */
  obligations: number;
  conditions: number;
  amendments: number;
  chunks: number;
  stagedRows: number;
  /** True when a person approved something out of this document. */
  reviewed: boolean;
  /** Set when another version names this one as what it replaced. */
  blockedBy: { id: string; title: string } | null;
  /**
   * Whether a stored PDF will actually be deleted. False for the documents that
   * ship inside the app bundle — their file is read-only, stays where it is,
   * and the document can be added again afterwards.
   */
  fileRemoved: boolean;
}

export interface RemovalResult extends RemovalPreview {
  removed: true;
}

/** Look up exactly what removal would take with it. */
export async function previewRemoval(id: string): Promise<RemovalPreview> {
  const version = await prisma.sourceVersion.findUnique({
    where: { id },
    include: {
      supersededBy: { select: { id: true, title: true } },
      _count: {
        select: { obligations: true, conditions: true, amendments: true, chunks: true, stagedRows: true },
      },
    },
  });
  if (!version) throw new Error("That document is not in the library.");

  const reviewed = await prisma.stagedRow.count({
    where: { sourceVersionId: id, status: { not: "pending" } },
  });

  return {
    id: version.id,
    title: version.title,
    obligations: version._count.obligations,
    conditions: version._count.conditions,
    amendments: version._count.amendments,
    chunks: version._count.chunks,
    stagedRows: version._count.stagedRows,
    reviewed: reviewed > 0,
    blockedBy: version.supersededBy[0] ?? null,
    fileRemoved: userFilePath(version.storedPath, version.sourceFile) !== null,
  };
}

/**
 * Remove a document and everything derived from it.
 *
 * Ordered so nothing is ever left pointing at something that no longer exists,
 * and run in one transaction so a failure half way through leaves the library
 * exactly as it was.
 */
export async function removeDocument(id: string): Promise<RemovalResult> {
  const preview = await previewRemoval(id);
  if (preview.blockedBy) {
    throw new Error(
      `"${preview.blockedBy.title}" records this document as the version it replaced. ` +
        `Removing it would erase what replaced what. Remove that document first, or retire ` +
        `this one instead of deleting it.`
    );
  }

  const version = await prisma.sourceVersion.findUnique({
    where: { id },
    select: { storedPath: true, sourceFile: true },
  });
  if (!version) throw new Error("That document is not in the library.");

  const obligations = await prisma.obligation.findMany({
    where: { sourceVersionId: id },
    select: { id: true },
  });
  const obligationIds = obligations.map((o) => o.id);

  await prisma.$transaction([
    // An amendment in ANOTHER document may record that it was applied to one of
    // these obligations. That pointer has to go before its target does, and it
    // is only ever a cross-reference — the amendment itself survives.
    prisma.amendment.updateMany({
      where: { appliedToObligationId: { in: obligationIds } },
      data: { appliedToObligationId: null },
    }),
    prisma.parseRun.deleteMany({ where: { sourceVersionId: id } }),
    prisma.stagedRow.deleteMany({ where: { sourceVersionId: id } }),
    prisma.chunk.deleteMany({ where: { sourceVersionId: id } }),
    prisma.amendment.deleteMany({ where: { sourceVersionId: id } }),
    prisma.condition.deleteMany({ where: { sourceVersionId: id } }),
    prisma.obligation.deleteMany({ where: { sourceVersionId: id } }),
    prisma.sourceVersion.delete({ where: { id } }),
  ]);

  // Last, and outside the transaction: a file that cannot be unlinked must not
  // roll back a database change that already succeeded. A leftover PDF is
  // recoverable; a library row pointing at a document nobody can see is not.
  const path = userFilePath(version.storedPath, version.sourceFile);
  if (path) await unlink(path).catch(() => {});

  return { ...preview, removed: true };
}

/**
 * The file this document owns, if removal should delete one.
 *
 * Two conditions, and both matter. It must sit inside the writable documents
 * folder — the bundled four live in a read-only bundle, and a delete aimed
 * there either fails or, worse, succeeds on a developer's machine and quietly
 * removes a document from the repository. And it must actually be there: a
 * bundled document names `cet.pdf`, which resolves to a plausible path under
 * the user folder that has never existed, and reporting "the stored PDF will be
 * deleted" for a file that will not be touched is a preview that lies.
 */
function userFilePath(storedPath: string | null, sourceFile: string | null): string | null {
  const dir = resolve(docsDir());
  const candidate = storedPath
    ? resolve(storedPath)
    : sourceFile
      ? resolve(join(dir, basename(sourceFile)))
      : null;
  if (!candidate) return null;
  if (!candidate.startsWith(dir + sep) && candidate !== dir) return null;
  return existsSync(candidate) ? candidate : null;
}
