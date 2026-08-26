import { prisma } from "../../lib/db";
import { sha256File } from "./pdf";

export interface SourceInput {
  path: string;
  title: string;
  issuer: string;
  docType: "A" | "B" | "C" | "D";
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  sourceFile?: string | null; // served PDF filename under public/docs (for deep links)
}

export interface EnsureResult {
  sourceVersionId: string;
  contentHash: string;
  alreadyLoaded: boolean;
}

/**
 * Append-only ingest. Hash-first: if this exact file was already loaded we
 * return the existing version and do nothing (loaders are run dozens of times).
 * Never mutates an existing SourceVersion — that would break the audit trail.
 */
export async function ensureSourceVersion(
  input: SourceInput,
  dryRun: boolean
): Promise<EnsureResult> {
  const contentHash = sha256File(input.path);
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
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
    },
  });
  return { sourceVersionId: created.id, contentHash, alreadyLoaded: false };
}

export function parseArgs(argv: string[]): { file?: string; dryRun: boolean; rest: string[] } {
  const rest = argv.slice(2);
  const dryRun = rest.includes("--dry-run");
  const file = rest.find((a) => !a.startsWith("--"));
  return { file, dryRun, rest };
}
