// The parser registry.
//
// A document is routed to the parsers that suit its type, and everything they
// produce is written to `staged_rows` — never to `obligations` or `conditions`.
// assess() does not read the staging table, so a parser being wrong about an
// unfamiliar document costs a rejected suggestion rather than a wrong duty on
// somebody's declaration. That separation is what makes it safe to run generic
// parsers over documents nobody has inspected.
//
// Each run also records its coverage. CLAUDE.md asks every loader to report
// rows matched against candidate lines seen, so the size of the gap is known;
// storing it lets the UI show a new document against the CET's ~99% benchmark.

import { prisma } from "../../db";
import type { PdfPage } from "../../pdf/types";
import type { Classification } from "../classify";
import { parseSchedule } from "./schedule-columns";
import { parseAmendments } from "./amending-act";
import { parseConditions } from "./conditions";

export interface ParserContext {
  sourceVersionId: string;
  pages: PdfPage[];
  pageText: string[];
  classification: Classification;
  effectiveFrom: Date;
  title: string;
}

/** Shape of a proposed obligation, stored as JSON on the staged row. */
export interface StagedObligation {
  hsPrefix: string;
  type: string;
  rate: number | null;
  specificRate: string | null;
  basis: string;
  legalRef: string;
  sourcePage: number;
  needsReview: boolean;
  description: string;
  effectiveFrom: string;
}

export interface StagedCondition {
  hsPrefix: string;
  conditionType: string;
  detail: string;
  legalRef: string;
  sourcePage: number | null;
  effectiveFrom: string;
}

export interface StagedAmendment {
  targetAct: string;
  targetSection: string;
  operation: string;
  text: string;
  sourcePage: number;
  effectiveFrom: string;
}

/**
 * Run whichever parsers suit this document and stage what they find.
 *
 * Returns how many rows actually reached the review queue, which on a re-read
 * is fewer than were proposed: anything a person has already ruled on is not
 * put back in front of them.
 */
export async function runParsers(ctx: ParserContext): Promise<number> {
  switch (ctx.classification.docType) {
    case "A":
      return stageSchedule(ctx);
    case "C":
      return stageAmendments(ctx);
    case "D":
      return stageConditions(ctx);
    default:
      // Type B is a scan nothing could be read from. It is still fully
      // searchable — that happened before parsing — but proposing rows from
      // text this poor would only manufacture work.
      await recordRun(ctx.sourceVersionId, "none", 0, 0, ctx.classification.reason);
      return 0;
  }
}

async function stageSchedule(ctx: ParserContext): Promise<number> {
  const { rows, linesSeen, pagesWithGrid, roles } = parseSchedule(ctx.pages);

  const staged = rows.map((r) => ({
    sourceVersionId: ctx.sourceVersionId,
    kind: "obligation",
    parserId: "schedule-columns",
    confidence: r.confidence,
    snippet: r.snippet.slice(0, 1000),
    sourcePage: r.page,
    payload: JSON.stringify({
      hsPrefix: r.hsPrefix,
      type: "duty",
      rate: r.rate,
      specificRate: r.specificRate,
      basis: "customs_value",
      legalRef: `${ctx.title}, tariff ${r.hsCode}`,
      sourcePage: r.page,
      needsReview: r.needsReview,
      description: r.description,
      effectiveFrom: ctx.effectiveFrom.toISOString(),
    } satisfies StagedObligation),
  }));

  const inserted = await insertStaged(staged);
  await recordRun(
    ctx.sourceVersionId,
    "schedule-columns",
    linesSeen,
    rows.length,
    `Column grid found on ${pagesWithGrid} pages; columns read as ${roles.join(", ") || "unknown"}.`
  );
  return inserted;
}

async function stageAmendments(ctx: ParserContext): Promise<number> {
  const { amendments, stats } = parseAmendments(ctx.pages);

  const staged = amendments.map((a) => ({
    sourceVersionId: ctx.sourceVersionId,
    kind: "amendment",
    parserId: "amending-act",
    // An amendment is never more or less certain than any other: a person has
    // to read it either way. CLAUDE.md is explicit that auto-applying one is
    // the worst failure this system has.
    confidence: 0.5,
    snippet: a.text.slice(0, 1000),
    sourcePage: a.page,
    payload: JSON.stringify({
      targetAct: a.targetAct,
      targetSection: a.targetSection,
      operation: a.operation,
      text: a.text,
      sourcePage: a.page,
      effectiveFrom: ctx.effectiveFrom.toISOString(),
    } satisfies StagedAmendment),
  }));

  const inserted = await insertStaged(staged);
  await recordRun(
    ctx.sourceVersionId,
    "amending-act",
    stats.amendmentMentions,
    amendments.length,
    `Margin column removed on ${stats.pagesWithMarginStripped}/${stats.pagesSeen} pages.`
  );
  return inserted;
}

async function stageConditions(ctx: ParserContext): Promise<number> {
  const { conditions, linesSeen } = parseConditions(ctx.pageText, ctx.title);

  const staged = conditions.map((c) => ({
    sourceVersionId: ctx.sourceVersionId,
    kind: "condition",
    parserId: "conditions",
    confidence: c.confidence,
    snippet: c.detail.slice(0, 1000),
    sourcePage: c.page,
    payload: JSON.stringify({
      hsPrefix: c.hsPrefix,
      conditionType: c.conditionType,
      detail: c.detail,
      legalRef: `${ctx.title}, p.${c.page}`,
      sourcePage: c.page,
      effectiveFrom: ctx.effectiveFrom.toISOString(),
    } satisfies StagedCondition),
  }));

  const inserted = await insertStaged(staged);
  await recordRun(ctx.sourceVersionId, "conditions", linesSeen, conditions.length, null);
  return inserted;
}

type StagedInsert = {
  sourceVersionId: string;
  kind: string;
  parserId: string;
  confidence: number;
  snippet: string;
  sourcePage: number | null;
  payload: string;
};

/**
 * A stable identity for a proposal, independent of how it was parsed.
 *
 * Only the fields that decide what the row would BECOME go in — not the
 * snippet, not the confidence, not the parser that read it. A re-read of the
 * same document with a better extractor produces the same key for the same
 * tariff line even when the surrounding text came out differently, which is the
 * whole point: a reviewer who has already accepted or rejected that line must
 * not be shown it again.
 */
function stagedKey(kind: string, payload: string): string {
  try {
    const p = JSON.parse(payload) as Record<string, unknown>;
    if (kind === "obligation") return `o|${p.hsPrefix}|${p.type}|${p.rate}|${p.specificRate}`;
    if (kind === "condition") return `c|${p.hsPrefix}|${p.conditionType}|${p.detail}`;
    if (kind === "amendment") return `a|${p.targetAct}|${p.targetSection}|${p.operation}|${p.text}`;
  } catch {
    // A payload that will not parse cannot be matched against anything; let it
    // through and let a reviewer see it rather than dropping it silently.
  }
  return `${kind}|${payload}`;
}

/**
 * Stage proposals, minus anything a person has already ruled on.
 *
 * This matters only on a re-read, and it is what makes a re-read safe to run on
 * a document somebody has already worked through: without it, every row they
 * approved comes back as a fresh suggestion and approving it a second time
 * writes a second obligation for the same tariff line. Rejections are filtered
 * too — a reviewer said no once, and re-reading the document is not a new
 * argument.
 */
async function insertStaged(rows: StagedInsert[]): Promise<number> {
  if (rows.length === 0) return 0;

  const ruled = await prisma.stagedRow.findMany({
    where: { sourceVersionId: rows[0].sourceVersionId, status: { not: "pending" } },
    select: { kind: true, payload: true },
  });
  const seen = new Set(ruled.map((r) => stagedKey(r.kind, r.payload)));
  const fresh = seen.size === 0 ? rows : rows.filter((r) => !seen.has(stagedKey(r.kind, r.payload)));

  const BATCH = 500;
  for (let i = 0; i < fresh.length; i += BATCH) {
    await prisma.stagedRow.createMany({ data: fresh.slice(i, i + BATCH) });
  }
  return fresh.length;
}

/**
 * Store one parser's coverage over one document.
 *
 * `linesSeen` is the denominator — candidate lines the parser recognised as its
 * kind of thing. When it is zero there is no ratio to report, and the stored
 * `coveragePct` of 0 means "undefined", not "read nothing of what was there".
 * Readers of this row have to tell those apart: a schedule that yielded 0 of
 * 4,000 rows is broken, whereas a memo with no tariff line in it was never
 * going to yield one. The distinction is carried by `linesSeen` itself, and
 * said out loud in the notes so nobody has to reconstruct it.
 */
async function recordRun(
  sourceVersionId: string,
  parserId: string,
  linesSeen: number,
  rowsMatched: number,
  notes: string | null
): Promise<void> {
  await prisma.parseRun.create({
    data: {
      sourceVersionId,
      parserId,
      linesSeen,
      rowsMatched,
      coveragePct: linesSeen > 0 ? (rowsMatched / linesSeen) * 100 : 0,
      notes:
        linesSeen === 0
          ? `Nothing for this parser to read: no line in the document was a candidate. ` +
            `Coverage does not apply.${notes ? ` ${notes}` : ""}`
          : notes,
    },
  });
}
