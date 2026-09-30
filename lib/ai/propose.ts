// Turning an audit finding into a proposal a person can approve or reject.
//
// This is the only write path out of the AI layer, and it deliberately writes
// to exactly one table: `staged_rows`. That table already exists for precisely
// this problem — CLAUDE.md calls it "the safety mechanism for user-added
// documents": a parser reading an unfamiliar table writes there, a person
// approves it, and only then does it become an Obligation carrying their name.
// assess() never reads staging.
//
// An audit finding is the same kind of thing as a parser's proposal — a machine
// noticed something, and a person decides. So it goes to the same queue, with
// the same review page, the same approval path, and the same guarantee that
// nothing reaches an assessment without somebody's name on it.
//
// Three things keep it distinguishable from a parser's work:
//   - `parserId` is "ai-audit", so the review page can badge it and a reviewer
//     always knows a model proposed this.
//   - `snippet` carries the finding and the row ids it cited, so the evidence
//     travels with the proposal rather than living only in the audit log.
//   - `confidence` reflects how well-EVIDENCED the proposal is, never how
//     legally correct it is. CLAUDE.md is explicit that the field means the
//     former; a model's self-assessed certainty about the law is worth nothing
//     and is not recorded.

import { prisma } from "../db";
import type { Finding } from "./audit";

/** How a proposal is stamped, so a reviewer and a query can both find them. */
export const AI_PARSER_ID = "ai-audit";

export interface ProposalResult {
  created: number;
  /** Findings carrying a proposal that was not written, and why. */
  skipped: { statement: string; reason: string }[];
}

/**
 * A model proposal is never well-evidenced enough to look like a clean parse.
 *
 * The review queue sorts least-confident first, deliberately, so the rows most
 * likely to need a correction reach a person's attention first. A model's
 * proposal belongs at the top of that list, so it is pinned low.
 */
const AI_CONFIDENCE = 0.2;

/**
 * Write the proposals attached to verified findings.
 *
 * Only findings that survived citation checking should reach here — the caller
 * passes `verification.kept`, never the raw model output.
 */
export async function proposeFromFindings(
  findings: Finding[],
  context: { hsCode: string; requestedBy: string | null; reportId: string }
): Promise<ProposalResult> {
  const result: ProposalResult = { created: 0, skipped: [] };
  const withProposals = findings.filter((f) => f.proposal);
  if (withProposals.length === 0) return result;

  // A proposal has to hang off a source version: `staged_rows.sourceVersionId`
  // is NOT NULL, and rule 2 means an approved row needs a document behind it.
  // The document is chosen from what the finding cites, not from the model's
  // say-so.
  for (const finding of withProposals) {
    const p = finding.proposal!;
    try {
      const sourceVersionId = await sourceVersionFor(finding.citations);
      if (!sourceVersionId) {
        result.skipped.push({
          statement: finding.statement,
          reason: "none of its cited rows resolve to a source document",
        });
        continue;
      }

      const payload = buildPayload(p);
      if (!payload) {
        result.skipped.push({ statement: finding.statement, reason: "the proposal is not a complete row" });
        continue;
      }

      // Do not re-propose something a person has already ruled on, or something
      // already sitting in the queue. Running the audit twice on the same item
      // must not put the same suggestion in front of a reviewer twice.
      const duplicate = await prisma.stagedRow.findFirst({
        where: { sourceVersionId, kind: p.kind, payload: JSON.stringify(payload) },
        select: { id: true, status: true },
      });
      if (duplicate) {
        result.skipped.push({
          statement: finding.statement,
          reason: duplicate.status === "pending" ? "already in the review queue" : `already ${duplicate.status}`,
        });
        continue;
      }

      await prisma.stagedRow.create({
        data: {
          sourceVersionId,
          kind: p.kind,
          payload: JSON.stringify(payload),
          snippet: evidenceSnippet(finding, context),
          sourcePage: null,
          confidence: AI_CONFIDENCE,
          parserId: AI_PARSER_ID,
          status: "pending",
        },
      });
      result.created++;
    } catch (err) {
      result.skipped.push({ statement: finding.statement, reason: (err as Error).message });
    }
  }

  return result;
}

/**
 * Which document a proposal belongs to, decided from the rows the finding cited.
 *
 * The model does not get to name it: an id it invented would attach a proposal
 * to the wrong Act, and rule 2 makes the document part of the citation an
 * approved row will carry for the rest of its life.
 */
async function sourceVersionFor(citations: string[]): Promise<string | null> {
  if (citations.length === 0) return null;

  const [obligation, condition, amendment, staged] = await Promise.all([
    prisma.obligation.findFirst({ where: { id: { in: citations } }, select: { sourceVersionId: true } }),
    prisma.condition.findFirst({ where: { id: { in: citations } }, select: { sourceVersionId: true } }),
    prisma.amendment.findFirst({ where: { id: { in: citations } }, select: { sourceVersionId: true } }),
    prisma.stagedRow.findFirst({ where: { id: { in: citations } }, select: { sourceVersionId: true } }),
  ]);

  const fromRow = obligation ?? condition ?? amendment ?? staged;
  if (fromRow) return fromRow.sourceVersionId;

  // list_documents cites source versions directly.
  const version = await prisma.sourceVersion.findFirst({ where: { id: { in: citations } }, select: { id: true } });
  return version?.id ?? null;
}

/**
 * Shape the proposal like the table it would become.
 *
 * `effectiveFrom` is deliberately left as today's date ONLY for the staged row's
 * payload, and the reviewer edits it — the same compromise the ingest pipeline
 * makes. A rate is never carried through: a model does not get to propose a
 * figure, so an obligation proposal always arrives with a null rate and
 * needsReview set, which means a person must type the number themselves.
 */
function buildPayload(p: NonNullable<Finding["proposal"]>): Record<string, unknown> | null {
  if (p.kind === "condition") {
    const detail = typeof p.detail === "string" ? p.detail.trim() : "";
    if (!detail) return null;
    return {
      hsPrefix: p.hsPrefix,
      conditionType: ["pvoc", "exemption", "restriction"].includes(String(p.conditionType))
        ? p.conditionType
        : "restriction",
      detail,
      legalRef: p.legalRef,
      sourcePage: null,
      effectiveFrom: new Date().toISOString().slice(0, 10),
    };
  }

  if (p.kind === "obligation") {
    return {
      hsPrefix: p.hsPrefix,
      type: ["duty", "vat", "idf", "rdl", "excise"].includes(String(p.type)) ? p.type : "duty",
      // Never the model's number. lib/ingest/review.ts forces needsReview on a
      // null rate anyway; this makes the intent explicit at the point it is
      // written rather than relying on the check downstream.
      rate: null,
      specificRate: null,
      basis: p.basis === "cif_plus_duty" ? "cif_plus_duty" : "customs_value",
      legalRef: p.legalRef,
      sourcePage: null,
      needsReview: true,
      description: typeof p.description === "string" ? p.description : "",
      effectiveFrom: new Date().toISOString().slice(0, 10),
    };
  }

  return null;
}

/** The evidence a reviewer sees beside the proposal. */
function evidenceSnippet(finding: Finding, context: { hsCode: string; requestedBy: string | null; reportId: string }): string {
  return [
    `Proposed by the AI audit of ${context.hsCode}${context.requestedBy ? `, run by ${context.requestedBy}` : ""}.`,
    ``,
    `Finding (${finding.severity}): ${finding.statement}`,
    finding.proposal?.reason ? `Reason given: ${finding.proposal.reason}` : "",
    finding.officerAction ? `Suggested check: ${finding.officerAction}` : "",
    ``,
    `Rows cited: ${finding.citations.join(", ") || "none"}`,
    `Audit record: ${context.reportId}`,
    ``,
    `A model proposed this. Nothing here has been verified against the document —`,
    `open the legal reference and confirm it before approving.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}
