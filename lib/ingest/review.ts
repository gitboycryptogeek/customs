// Turning approved suggestions into real rules.
//
// This is the only path by which anything a parser produced can reach an
// assessment, and it runs when a person says so. Until then a staged row sits
// beside the document it came from, with the source text attached, and assess()
// cannot see it.
//
// On approval the row becomes a real Obligation or Condition carrying its
// legalRef, its page, its effective date and the name of whoever approved it —
// so the audit trail names a person, not a parser.

import { prisma } from "../db";
import type { StagedObligation, StagedCondition, StagedAmendment } from "./parsers";

export interface ApprovalResult {
  approved: number;
  rejected: number;
  /** Rows that could not be applied, with why. */
  failed: { id: string; reason: string }[];
}

/**
 * Approve staged rows, optionally with edits.
 *
 * Edits are merged over the parsed payload before it is written, because the
 * common case for a reviewer is not "accept or bin" but "the rate is right and
 * the description lost a word".
 */
export async function approve(
  ids: string[],
  reviewedBy: string,
  edits: Record<string, Record<string, unknown>> = {}
): Promise<ApprovalResult> {
  const rows = await prisma.stagedRow.findMany({
    where: { id: { in: ids }, status: "pending" },
    include: { sourceVersion: { select: { title: true } } },
  });

  const result: ApprovalResult = { approved: 0, rejected: 0, failed: [] };

  for (const row of rows) {
    try {
      const payload = { ...JSON.parse(row.payload), ...(edits[row.id] ?? {}) };
      let producedId: string | null = null;

      if (row.kind === "obligation") {
        producedId = await applyObligation(row.sourceVersionId, payload as StagedObligation);
      } else if (row.kind === "condition") {
        producedId = await applyCondition(row.sourceVersionId, payload as StagedCondition);
      } else if (row.kind === "amendment") {
        producedId = await applyAmendment(row.sourceVersionId, payload as StagedAmendment);
      } else {
        throw new Error(`Unknown staged row kind "${row.kind}"`);
      }

      await prisma.stagedRow.update({
        where: { id: row.id },
        data: { status: "approved", reviewedBy, reviewedAt: new Date(), producedId },
      });
      result.approved++;
    } catch (err) {
      result.failed.push({ id: row.id, reason: (err as Error).message });
    }
  }

  return result;
}

/** Reject staged rows. Nothing is deleted — a rejection is part of the record. */
export async function reject(ids: string[], reviewedBy: string): Promise<ApprovalResult> {
  const { count } = await prisma.stagedRow.updateMany({
    where: { id: { in: ids }, status: "pending" },
    data: { status: "rejected", reviewedBy, reviewedAt: new Date() },
  });
  return { approved: 0, rejected: count, failed: [] };
}

async function applyObligation(sourceVersionId: string, p: StagedObligation): Promise<string> {
  if (!p.legalRef) throw new Error("An obligation needs a legal reference before it can be saved.");
  // Rule 2: every figure carries a legal reference and a version date. Both are
  // NOT NULL on the table; this check makes the failure legible rather than a
  // constraint violation.
  const created = await prisma.obligation.create({
    data: {
      sourceVersionId,
      hsPrefix: p.hsPrefix ?? "",
      type: p.type || "duty",
      rate: p.rate,
      specificRate: p.specificRate ?? null,
      basis: p.basis || "customs_value",
      legalRef: p.legalRef,
      sourcePage: p.sourcePage ?? null,
      // A null rate always needs review, whatever the reviewer said: it is not
      // zero, and no total may be built on it.
      needsReview: p.needsReview || p.rate === null,
      effectiveFrom: new Date(p.effectiveFrom),
    },
  });

  // The description travels with the rule so search and the result header can
  // find it, keyed by HS prefix like every other tariff description. Marked as
  // approval's rather than the extractor's: this one exists because a person
  // approved the rule it describes, and re-reading the document must not
  // silently discard it.
  if (p.description) {
    await prisma.chunk.create({
      data: {
        sourceVersionId,
        sectionRef: p.hsPrefix,
        text: p.description,
        sourcePage: p.sourcePage ?? null,
        origin: "approval",
      },
    });
  }
  return created.id;
}

async function applyCondition(sourceVersionId: string, p: StagedCondition): Promise<string> {
  if (!p.legalRef) throw new Error("A condition needs a legal reference before it can be saved.");
  const created = await prisma.condition.create({
    data: {
      sourceVersionId,
      hsPrefix: p.hsPrefix ?? "",
      conditionType: p.conditionType || "restriction",
      detail: p.detail,
      legalRef: p.legalRef,
      sourcePage: p.sourcePage ?? null,
      effectiveFrom: new Date(p.effectiveFrom),
    },
  });
  return created.id;
}

/**
 * An approved amendment joins the amendments queue. It still does not change a
 * rate — approving it here means "yes, this is a real amendment worth tracking",
 * not "apply it". Which obligation it changes is a separate human decision, and
 * CLAUDE.md is explicit that automating it is the worst failure this system has.
 */
async function applyAmendment(sourceVersionId: string, p: StagedAmendment): Promise<string> {
  const created = await prisma.amendment.create({
    data: {
      sourceVersionId,
      targetAct: p.targetAct,
      targetSection: p.targetSection,
      operation: p.operation,
      text: p.text,
      effectiveFrom: new Date(p.effectiveFrom),
    },
  });
  return created.id;
}
