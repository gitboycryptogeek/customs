// The evidence pack: everything the briefing model is given, and the only thing
// that ever leaves this machine.
//
// It is assembled here, server-side, from deterministic output — assess() and
// searchLaw() have already run and produced every figure in it. The model's job
// is to restate this in prose for an officer; it decides nothing. lib/ai/verify.ts
// then checks the prose back against this object, which is why the pack is built
// as a value rather than formatted straight into a prompt string: the same object
// grounds the request, the verification, and the "what will be sent" panel the
// officer sees before the call.
//
// Nothing may be added to this shape without asking what it would mean for it to
// be read by somebody outside KRA. Everything here is either a figure already on
// the officer's screen, or text from a document that is published.

import type { AssessResult } from "../assess";
import { basisLabel, levyLabel, money, ratePct } from "../labels";
import { prisma } from "../db";
import { searchLaw } from "../search";
import { redactTerm } from "./redact";
import { documentScope, type DocumentScope } from "./scope";

export interface EvidenceCharge {
  label: string;
  ratePct: string;
  specificRate: string | null;
  chargedOn: string;
  amount: string;
  legalRef: string;
  sourceTitle: string | null;
  page: number | null;
  needsReview: boolean;
}

export interface EvidencePassage {
  sourceTitle: string;
  hsCode: string | null;
  page: number | null;
  text: string;
}

export interface EvidencePack {
  item: { query: string; hsCode: string; description: string | null; resolvedVia: string };
  declared: { customsValue: string; importerType: string };
  charges: EvidenceCharge[];
  total: string | null;
  totalBlocked: boolean;
  flags: { severity: string; message: string }[];
  conditions: { type: string; detail: string; legalRef: string; page: number | null }[];
  passages: EvidencePassage[];
  /**
   * Documents on this machine the AI was not permitted to read. Stated in the
   * pack rather than filtered out silently, so the model knows its view is
   * partial and says so. See lib/ai/scope.ts.
   */
  withheldDocuments: number;
  documentsLoaded: { title: string; issuer: string; docType: string; effectiveFrom: string; effectiveTo: string | null }[];
  rulesAsAt: string;
}

/** How many law passages to include. Enough to ground the prose, bounded so the prompt stays small. */
const MAX_PASSAGES = 8;

export interface EvidenceInput {
  /** What the item was looked up as. Redacted here before it goes anywhere. */
  itemQuery: string;
  /** How lib/search.ts resolved it: exact | alias | fulltext. */
  resolvedVia: string;
  customsValue: number;
  importerType: string;
  assessment: AssessResult;
  /** Resolved once by the caller so an audit's whole run shares one view. */
  scope?: DocumentScope;
}

/**
 * Build the pack from a completed assessment.
 *
 * The declared value and importer type are passed in rather than read off the
 * assessment: `AssessResult` is the engine's output contract and carries the
 * charges, not the inputs that produced them.
 *
 * `assess()` does return `sourceVersionId` on every line but not the document's
 * title, and the title is what a person recognises a citation by. Those are
 * resolved in one query here rather than by widening AssessResult, which
 * CLAUDE.md pins.
 */
export async function buildEvidence(input: EvidenceInput): Promise<EvidencePack> {
  const { itemQuery, resolvedVia, customsValue, importerType, assessment } = input;
  const scope = input.scope ?? (await documentScope());

  const versionIds = [...new Set(assessment.lines.map((l) => l.sourceVersionId))];
  const versions = versionIds.length
    ? await prisma.sourceVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, title: true } })
    : [];
  const titleById = new Map(versions.map((v) => [v.id, v.title]));

  const loaded = await prisma.sourceVersion.findMany({
    where: scope.allowed ? { id: { in: scope.allowed } } : undefined,
    select: { title: true, issuer: true, docType: true, effectiveFrom: true, effectiveTo: true },
    orderBy: { effectiveFrom: "desc" },
  });

  // Passages are searched on the tariff description rather than on what the
  // officer typed: the description is the CET's own words, so it finds the
  // provisions that actually govern this line, and it carries nothing a person
  // entered. Falls back to the redacted query when the code resolved with no
  // description behind it.
  const redactedQuery = redactTerm(itemQuery);
  const passageQuery = assessment.description || redactedQuery;
  const hits = passageQuery ? await searchLaw(passageQuery, MAX_PASSAGES, scope.allowed) : [];

  return {
    item: {
      query: redactedQuery,
      hsCode: assessment.hsCode,
      description: assessment.description,
      resolvedVia,
    },
    declared: {
      // Formatted exactly as the screen shows it. The model restates figures, it
      // never computes with them, so every number it is given should already be
      // in the form it is allowed to write.
      customsValue: money(customsValue),
      importerType,
    },
    charges: assessment.lines.map((l) => ({
      label: levyLabel(l.type),
      ratePct: ratePct(l.rate),
      specificRate: l.specificRate ?? null,
      chargedOn: basisLabel(l.basis),
      amount: money(l.amount),
      legalRef: l.legalRef,
      sourceTitle: titleById.get(l.sourceVersionId) ?? null,
      page: l.page,
      needsReview: l.needsReview,
    })),
    total: assessment.total === null ? null : money(assessment.total),
    totalBlocked: assessment.total === null,
    flags: assessment.flags.map((f) => ({ severity: f.severity, message: f.message })),
    conditions: assessment.conditions.map((c) => ({
      type: c.type,
      detail: c.detail,
      legalRef: c.legalRef,
      page: c.page,
    })),
    withheldDocuments: scope.withheldCount,
    passages: hits.map((h) => ({
      sourceTitle: h.sourceTitle,
      hsCode: h.hsCode,
      page: h.page,
      text: h.snippet,
    })),
    documentsLoaded: loaded.map((d) => ({
      title: d.title,
      issuer: d.issuer,
      docType: d.docType,
      effectiveFrom: d.effectiveFrom.toISOString().slice(0, 10),
      effectiveTo: d.effectiveTo ? d.effectiveTo.toISOString().slice(0, 10) : null,
    })),
    rulesAsAt: assessment.rulesAsAt.toISOString().slice(0, 10),
  };
}
