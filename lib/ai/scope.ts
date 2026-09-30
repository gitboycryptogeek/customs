// Which documents the AI is allowed to read.
//
// The four documents that ship with the app are published law — the EAC tariff
// and Kenyan Acts. Anything a user adds through the Documents page is not
// necessarily anything of the kind: it might be an internal KRA circular, a
// freight memo, or a draft nobody outside the building should see. Both live in
// the same tables and both are searchable, so without this the briefing and the
// audit would read them out to an external service identically.
//
// Default: bundled documents only.
//
// The important part is what happens to the excluded ones. They are not
// silently dropped — the model is TOLD how many documents it was not permitted
// to read. A partial view it knows is partial produces "this assessment draws on
// a local document I could not check; an officer must verify that line by hand",
// which is a useful finding. A partial view it thinks is complete produces a
// confident all-clear over material it never saw, which is the worst output this
// feature could generate.
//
// The discriminator is `storedPath`. It is null for the bundled documents, which
// live inside the read-only app bundle, and set for anything a user added, which
// has to go to the writable per-user folder. `addedBy` looks like the natural
// field for this and is not: it is a free-text box on the upload form that
// people leave blank.

import { prisma } from "../db";
import { readSettings } from "./config";

export interface DocumentScope {
  /** Source version ids the AI may read, or null when everything is allowed. */
  allowed: string[] | null;
  /** How many documents were held back. */
  withheldCount: number;
  /** Said to the model verbatim, so it knows its view is partial. */
  note: string | null;
}

/** Everything is permitted — used when the setting is on, and by the CLI checks. */
export const UNRESTRICTED: DocumentScope = { allowed: null, withheldCount: 0, note: null };

/**
 * Work out what this install lets the AI see.
 *
 * Called once per briefing or audit and threaded through, rather than consulted
 * per query: a scope that could change halfway through an audit would make the
 * tool log an unreliable record of what the model was shown.
 */
export async function documentScope(): Promise<DocumentScope> {
  if (readSettings().includeAddedDocuments) return UNRESTRICTED;

  const [bundled, withheldCount] = await Promise.all([
    prisma.sourceVersion.findMany({ where: { storedPath: null }, select: { id: true } }),
    prisma.sourceVersion.count({ where: { NOT: { storedPath: null } } }),
  ]);

  return {
    allowed: bundled.map((d) => d.id),
    withheldCount,
    note:
      withheldCount === 0
        ? null
        : `${withheldCount} document${withheldCount === 1 ? "" : "s"} added on this machine ` +
          `${withheldCount === 1 ? "is" : "are"} withheld from you and cannot be searched. ` +
          `If a figure or a rule traces to one of them you cannot verify it — say so and tell the ` +
          `officer to check that line against the document by hand. Do not guess at what they contain.`,
  };
}

/** A Prisma `where` fragment restricting rows to the permitted documents. */
export function scopeFilter(scope: DocumentScope): { sourceVersionId?: { in: string[] } } {
  return scope.allowed ? { sourceVersionId: { in: scope.allowed } } : {};
}
