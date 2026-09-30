// The read-only view of the database the audit model is allowed to query.
//
// In audit mode the model does not receive a fixed evidence pack — it asks
// questions and this module answers them. Three properties make that safe, and
// none of them depend on the model behaving:
//
//   1. READ ONLY. Every function here is a SELECT. Nothing in this file writes,
//      and nothing it imports writes. A finding that should change the rules
//      goes to the review queue (lib/ai/propose.ts) for a person to approve —
//      it never reaches `obligations` from here.
//   2. NO SQL. The model picks a tool and fills in typed parameters; it never
//      composes a query. There is no string from the model in any WHERE clause
//      that is not a bound parameter, and nothing it can ask can scan the whole
//      database or return an unbounded result.
//   3. EVERY ROW IS IDENTIFIED. Results carry their real row ids, because a
//      finding is only admissible if it cites a row the model actually read
//      (lib/ai/verify.ts). The tool log is the evidence.
//
// These are plain functions over Prisma with JSON-schema definitions beside
// them, deliberately free of any Anthropic or MCP types. Standing an MCP server
// in front of them later is a matter of mapping `TOOLS` onto that protocol's
// list/call handlers — the loop, the audit trail and the safety checks do not
// move.

import { prisma } from "../db";
import { hsDigits, hsPrefixes } from "../hs";
import { searchLaw } from "../search";
import { levyLabel, ratePct } from "../labels";
import { documentScope, scopeFilter, type DocumentScope } from "./scope";

/** Nothing a tool returns may exceed this many rows. */
const MAX_ROWS = 25;

/** JSON-schema tool definitions, in the shape the Messages API expects. */
export const TOOLS = [
  {
    name: "get_obligations",
    description:
      "Every duty/levy row on record for an HS code, INCLUDING ones the assessment did not use. " +
      "The engine applies longest-prefix-match and takes one row per levy type, so a broader or " +
      "narrower prefix, an expired row, or a second row at the same prefix is invisible in the " +
      "result an officer sees. This is the tool for checking whether the engine picked the right one.",
    input_schema: {
      type: "object" as const,
      properties: {
        hsCode: { type: "string", description: "HS code or prefix, e.g. '8471.30.00' or '8471'." },
        includeExpired: {
          type: "boolean",
          description: "Include rows whose effectiveTo has passed. Default false.",
        },
      },
      required: ["hsCode"],
    },
  },
  {
    name: "get_conditions",
    description:
      "Every condition (PVoC, exemption, restriction) on record for an HS code, for ALL importer " +
      "types — including ones filtered out of the assessment because they did not match this " +
      "importer. Use it to check whether a condition was excluded correctly.",
    input_schema: {
      type: "object" as const,
      properties: {
        hsCode: { type: "string", description: "HS code or prefix." },
      },
      required: ["hsCode"],
    },
  },
  {
    name: "find_amendments",
    description:
      "Search the amendments queue. A Finance Act never loads into the rules table — its " +
      "amendments sit here until a person applies them, so an amendment that changes a levy this " +
      "assessment used will NOT be reflected in the figures. Search by act name, section, or words " +
      "from the text, e.g. 'Cap. 469C' or 'railway development levy'.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Act name, section reference, or words from the amendment." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_staged_rows",
    description:
      "Parser proposals for an HS code that no person has approved or rejected yet. A pending row " +
      "proposing a different rate for a line the assessment used is a live disagreement worth " +
      "raising. These never affect an assessment.",
    input_schema: {
      type: "object" as const,
      properties: {
        hsCode: { type: "string", description: "HS code or prefix." },
      },
      required: ["hsCode"],
    },
  },
  {
    name: "search_law",
    description:
      "Full-text search across every loaded document. Use it to find the provision behind a figure, " +
      "or to check whether something the assessment does not mention appears in the law at all.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Words or a phrase to find." },
        limit: { type: "number", description: "Max passages, 1-15. Default 8." },
      },
      required: ["query"],
    },
  },
  {
    name: "list_documents",
    description:
      "Every source document loaded, with its type, effective dates and whether it has been " +
      "superseded. Use it to check whether a figure comes from a version that has since been " +
      "replaced, or whether a document that ought to govern this item is missing entirely.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

/** One tool call and what it returned. The audit trail, and the evidence a finding must cite. */
export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  /** Row ids returned, so a citation can be checked against what was actually read. */
  rowIds: string[];
  rowCount: number;
  result: unknown;
  ms: number;
  error?: string;
}

/**
 * Run one tool call.
 *
 * Unknown names and bad arguments come back as an `error` on the result rather
 * than thrown: the model should see that it asked for something impossible and
 * correct itself, and an exception here would abandon an audit that may already
 * have found something.
 */
export async function runTool(
  name: string,
  input: Record<string, unknown>,
  /** Resolved once per audit by the caller, so one run has one consistent view. */
  scope?: DocumentScope
): Promise<ToolCall> {
  const started = Date.now();
  const view = scope ?? (await documentScope());
  const call = (result: unknown, rowIds: string[] = []): ToolCall => ({
    name,
    input,
    rowIds,
    rowCount: rowIds.length,
    result,
    ms: Date.now() - started,
  });

  try {
    switch (name) {
      case "get_obligations":
        return await getObligations(String(input.hsCode ?? ""), input.includeExpired === true, view, call);
      case "get_conditions":
        return await getConditions(String(input.hsCode ?? ""), view, call);
      case "find_amendments":
        return await findAmendments(String(input.query ?? ""), view, call);
      case "get_staged_rows":
        return await getStagedRows(String(input.hsCode ?? ""), view, call);
      case "search_law":
        return await doSearchLaw(String(input.query ?? ""), Number(input.limit ?? 8), view, call);
      case "list_documents":
        return await listDocuments(view, call);
      default:
        return { ...call({ error: `No such tool: ${name}` }), error: `No such tool: ${name}` };
    }
  } catch (err) {
    const message = (err as Error).message;
    return { ...call({ error: message }), error: message };
  }
}

type Wrap = (result: unknown, rowIds?: string[]) => ToolCall;

async function getObligations(hsCode: string, includeExpired: boolean, view: DocumentScope, call: Wrap): Promise<ToolCall> {
  const prefixes = hsPrefixes(hsDigits(hsCode));
  const now = new Date();
  const rows = await prisma.obligation.findMany({
    where: {
      hsPrefix: { in: prefixes },
      ...scopeFilter(view),
      ...(includeExpired ? {} : { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }),
    },
    include: { sourceVersion: { select: { title: true, effectiveTo: true } } },
    orderBy: [{ hsPrefix: "desc" }, { type: "asc" }],
    take: MAX_ROWS,
  });

  const out = rows.map((o) => ({
    id: o.id,
    hsPrefix: o.hsPrefix,
    levy: levyLabel(o.type),
    type: o.type,
    rate: o.rate === null ? null : ratePct(Number(o.rate)),
    specificRate: o.specificRate,
    basis: o.basis,
    legalRef: o.legalRef,
    page: o.sourcePage,
    needsReview: o.needsReview,
    effectiveFrom: o.effectiveFrom.toISOString().slice(0, 10),
    effectiveTo: o.effectiveTo ? o.effectiveTo.toISOString().slice(0, 10) : null,
    document: o.sourceVersion.title,
    documentSuperseded: Boolean(o.sourceVersion.effectiveTo && o.sourceVersion.effectiveTo <= now),
  }));

  // Said explicitly, because the whole point of this tool is the rows the
  // assessment did NOT use, and a bare list does not make that visible.
  const note =
    `The engine uses longest-prefix-match and takes ONE row per levy type. ` +
    `Prefixes searched, longest first: ${prefixes.map((p) => p || "(all goods)").join(", ")}.`;

  return call({ note, obligations: out }, out.map((o) => o.id));
}

async function getConditions(hsCode: string, view: DocumentScope, call: Wrap): Promise<ToolCall> {
  const prefixes = hsPrefixes(hsDigits(hsCode));
  const rows = await prisma.condition.findMany({
    where: { hsPrefix: { in: prefixes }, ...scopeFilter(view) },
    include: { sourceVersion: { select: { title: true } } },
    orderBy: [{ hsPrefix: "desc" }],
    take: MAX_ROWS,
  });

  const out = rows.map((c) => ({
    id: c.id,
    hsPrefix: c.hsPrefix,
    conditionType: c.conditionType,
    detail: c.detail,
    appliesToImporterType: c.appliesToImporterType ?? "all importer types",
    legalRef: c.legalRef,
    page: c.sourcePage,
    effectiveFrom: c.effectiveFrom.toISOString().slice(0, 10),
    effectiveTo: c.effectiveTo ? c.effectiveTo.toISOString().slice(0, 10) : null,
    document: c.sourceVersion.title,
  }));
  return call({ conditions: out }, out.map((c) => c.id));
}

async function findAmendments(query: string, view: DocumentScope, call: Wrap): Promise<ToolCall> {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 6);

  // Matched in JS rather than with `contains`, because Prisma's case-insensitive
  // mode is unavailable on SQLite — a lowercased "cap" would never match
  // "Cap. 469C" and the tool would silently report no amendments, which is the
  // most dangerous wrong answer this tool can give. The queue is ~40 rows a
  // year (CLAUDE.md), so the bounded fetch below is cheap.
  const candidates = await prisma.amendment.findMany({
    where: scopeFilter(view),
    include: { sourceVersion: { select: { title: true } } },
    orderBy: { effectiveFrom: "desc" },
    take: 500,
  });

  const rows = (
    words.length
      ? candidates.filter((a) => {
          const hay = `${a.targetAct} ${a.targetSection} ${a.text}`.toLowerCase();
          return words.some((w) => hay.includes(w));
        })
      : candidates
  ).slice(0, MAX_ROWS);

  const out = rows.map((a) => ({
    id: a.id,
    targetAct: a.targetAct,
    targetSection: a.targetSection,
    operation: a.operation,
    text: a.text.length > 400 ? `${a.text.slice(0, 397)}…` : a.text,
    effectiveFrom: a.effectiveFrom ? a.effectiveFrom.toISOString().slice(0, 10) : null,
    // The field that matters: an amendment nobody has acted on is not in the rates.
    applied: Boolean(a.appliedToObligationId),
    reviewedBy: a.reviewedBy,
    document: a.sourceVersion.title,
  }));

  const note =
    `An amendment with applied=false has NOT been reflected in any rate. ` +
    `Report it as something for an officer to check — never treat it as changing a figure.`;
  return call({ note, amendments: out }, out.map((a) => a.id));
}

async function getStagedRows(hsCode: string, view: DocumentScope, call: Wrap): Promise<ToolCall> {
  const digits = hsDigits(hsCode);
  const prefixes = hsPrefixes(digits);
  const rows = await prisma.stagedRow.findMany({
    where: { status: "pending", ...scopeFilter(view) },
    include: { sourceVersion: { select: { title: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  // The prefix lives inside the JSON payload, so it is filtered here rather
  // than in the query. Bounded by the take above.
  const matching = rows
    .filter((r) => {
      try {
        const p = JSON.parse(r.payload) as { hsPrefix?: string };
        return typeof p.hsPrefix === "string" && prefixes.includes(p.hsPrefix);
      } catch {
        return false;
      }
    })
    .slice(0, MAX_ROWS);

  const out = matching.map((r) => ({
    id: r.id,
    kind: r.kind,
    proposedBy: r.parserId,
    confidence: r.confidence,
    payload: JSON.parse(r.payload),
    snippet: r.snippet.length > 300 ? `${r.snippet.slice(0, 297)}…` : r.snippet,
    page: r.sourcePage,
    document: r.sourceVersion.title,
  }));
  return call({ note: "Pending proposals. None of these affect an assessment.", staged: out }, out.map((r) => r.id));
}

async function doSearchLaw(query: string, limit: number, view: DocumentScope, call: Wrap): Promise<ToolCall> {
  const capped = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 8, 15));
  const hits = await searchLaw(query, capped, view.allowed);
  // searchLaw returns presentation rows without ids; a passage is cited by
  // document and page, which is what an officer opens anyway.
  return call({
    passages: hits.map((h) => ({
      document: h.sourceTitle,
      page: h.page,
      hsCode: h.hsCode,
      text: h.snippet,
    })),
  });
}

async function listDocuments(view: DocumentScope, call: Wrap): Promise<ToolCall> {
  const rows = await prisma.sourceVersion.findMany({
    where: view.allowed ? { id: { in: view.allowed } } : undefined,
    select: {
      id: true,
      title: true,
      issuer: true,
      docType: true,
      effectiveFrom: true,
      effectiveTo: true,
      supersedesId: true,
      addedBy: true,
      ingestStatus: true,
      meanOcrConfidence: true,
    },
    orderBy: { effectiveFrom: "desc" },
    take: MAX_ROWS,
  });

  const now = new Date();
  const out = rows.map((d) => ({
    id: d.id,
    title: d.title,
    issuer: d.issuer,
    docType: d.docType,
    effectiveFrom: d.effectiveFrom.toISOString().slice(0, 10),
    effectiveTo: d.effectiveTo ? d.effectiveTo.toISOString().slice(0, 10) : null,
    superseded: Boolean(d.effectiveTo && d.effectiveTo <= now),
    addedByUser: Boolean(d.addedBy),
    status: d.ingestStatus,
    // A low mean OCR confidence is a reason to distrust figures read from it.
    ocrConfidence: d.meanOcrConfidence,
  }));
  return call({ documents: out }, out.map((d) => d.id));
}
