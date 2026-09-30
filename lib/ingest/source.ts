// Registering a document version. Shared by the CLI loaders and the in-app
// ingest pipeline, so both go through one append-only path.
//
// Rule 3 in CLAUDE.md: documents are append-only. A source version is never
// updated or deleted. Re-loading the same file is a no-op rather than an
// overwrite, which is why the content hash is the identity.

import { prisma } from "../db";
import { sha256File } from "../pdf";

export interface SourceInput {
  path: string;
  title: string;
  issuer: string;
  docType: "A" | "B" | "C" | "D";
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  /** Served PDF filename, for the page-linked citations. */
  sourceFile?: string | null;
  storedPath?: string | null;
  originalFilename?: string | null;
  pageCount?: number | null;
  ingestStatus?: string;
  addedBy?: string | null;
  /** The version this replaces, e.g. last year's tariff. */
  supersedesId?: string | null;
}

export interface EnsureResult {
  sourceVersionId: string;
  contentHash: string;
  alreadyLoaded: boolean;
}

/**
 * Append-only ingest. Hash-first: if this exact file was already loaded we
 * return the existing version and do nothing — loaders get run dozens of times
 * while a parser is being tuned, and a user re-dropping the same folder must not
 * double every row.
 */
export async function ensureSourceVersion(
  input: SourceInput,
  dryRun = false
): Promise<EnsureResult> {
  const contentHash = await sha256File(input.path);
  const existing = await prisma.sourceVersion.findUnique({ where: { contentHash } });
  if (existing) {
    return { sourceVersionId: existing.id, contentHash, alreadyLoaded: true };
  }
  if (dryRun) {
    return { sourceVersionId: "(dry-run)", contentHash, alreadyLoaded: false };
  }
  const created = await prisma.sourceVersion.create({
    data: {
      title: input.title,
      issuer: input.issuer,
      contentHash,
      docType: input.docType,
      sourceFile: input.sourceFile ?? null,
      storedPath: input.storedPath ?? null,
      originalFilename: input.originalFilename ?? null,
      pageCount: input.pageCount ?? null,
      ingestStatus: input.ingestStatus ?? "ready",
      addedBy: input.addedBy ?? null,
      supersedesId: input.supersedesId ?? null,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
    },
  });
  return { sourceVersionId: created.id, contentHash, alreadyLoaded: false };
}

/**
 * Retire an earlier version by closing its effective window.
 *
 * This is the only correct way to replace a tariff: the old rows keep their
 * dates so a declaration filed last March is still assessed against the rules in
 * force last March. Nothing is deleted.
 */
export async function supersede(oldVersionId: string, newVersionId: string, from: Date): Promise<void> {
  await prisma.$transaction([
    prisma.sourceVersion.update({
      where: { id: oldVersionId },
      data: { effectiveTo: from },
    }),
    prisma.sourceVersion.update({
      where: { id: newVersionId },
      data: { supersedesId: oldVersionId },
    }),
    prisma.obligation.updateMany({
      where: { sourceVersionId: oldVersionId, effectiveTo: null },
      data: { effectiveTo: from },
    }),
    prisma.condition.updateMany({
      where: { sourceVersionId: oldVersionId, effectiveTo: null },
      data: { effectiveTo: from },
    }),
  ]);
}

export function parseArgs(argv: string[]): { file?: string; dryRun: boolean; rest: string[] } {
  const rest = argv.slice(2);
  const dryRun = rest.includes("--dry-run");
  const file = rest.find((a) => !a.startsWith("--"));
  return { file, dryRun, rest };
}
