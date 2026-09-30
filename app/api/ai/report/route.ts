import { NextResponse } from "next/server";

import { assess } from "@/lib/assess";
import { interpret } from "@/lib/interpret";
import { resolveHsCode } from "@/lib/search";
import { ensureReady } from "@/lib/startup";
import { prisma } from "@/lib/db";
import { aiStatus } from "@/lib/ai/config";
import { buildEvidence } from "@/lib/ai/evidence";
import { draftBriefing } from "@/lib/ai/report";
import { runAudit } from "@/lib/ai/audit";
import { proposeFromFindings } from "@/lib/ai/propose";
import { verifyReport, verifyFindings } from "@/lib/ai/verify";
import { documentScope } from "@/lib/ai/scope";

// The two AI modes, over one deterministic assessment.
//
//   mode: "brief"  one call. The model is handed the finished assessment and
//                  writes it up. Every figure it produces is checked back
//                  against that assessment.
//   mode: "audit"  the model queries the database itself through the read-only
//                  tools in lib/ai/tools.ts, looking for what the assessment
//                  could not show. Every finding must cite a row a query
//                  actually returned.
//
// The engine runs FIRST and in full, here on the server, for both. This route
// deliberately does not accept an evidence pack from the client: the pack is the
// grounding for a briefing and the starting context for an audit, so one
// supplied by the caller would defeat both. The client sends three scalars —
// the same three /api/assess takes — and everything else is rebuilt here.
//
// No trader PII is accepted or logged, and none is sent: interpret() reduces the
// query to an item phrase and lib/ai/redact.ts scrubs it. See lib/ai/evidence.ts
// for exactly what leaves the machine.

export const dynamic = "force-dynamic";

/** An audit issues several model calls and several queries; give it room. */
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    await ensureReady();

    const status = aiStatus();
    if (!status.ready) {
      return NextResponse.json(
        {
          error: status.configured
            ? "The AI briefing is switched off. Turn it on under Settings."
            : "No API key is configured. Add one under Settings.",
        },
        { status: 400 }
      );
    }

    const body = await req.json();
    const mode: "brief" | "audit" = body.mode === "audit" ? "audit" : "brief";

    const rawQuery: unknown = body.query;
    if (!rawQuery || typeof rawQuery !== "string") {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    // The same resolution the assessment on the officer's screen went through,
    // so the AI works from that assessment and not from a near miss.
    const said = interpret(rawQuery);
    const overrideValue = body.customsValue === "" || body.customsValue == null ? null : Number(body.customsValue);
    const customsValue = overrideValue !== null && Number.isFinite(overrideValue) ? overrideValue : said.customsValue;
    const importerType = (typeof body.importerType === "string" && body.importerType) || said.importerType;

    if (customsValue === null || !Number.isFinite(customsValue) || customsValue < 0) {
      return NextResponse.json({ error: "A customs value is needed first." }, { status: 400 });
    }

    const resolution = await resolveHsCode(said.itemQuery);
    if (!resolution.hsCode) {
      return NextResponse.json(
        { error: "No HS code matched this item, so there is nothing to work from yet." },
        { status: 400 }
      );
    }

    const assessment = await assess(resolution.hsCode, customsValue, importerType);

    // Resolved once here so the evidence pack and every tool call in an audit
    // share one view of which documents the AI may read (lib/ai/scope.ts).
    const scope = await documentScope();

    const evidence = await buildEvidence({
      itemQuery: said.itemQuery,
      resolvedVia: resolution.method,
      customsValue,
      importerType,
      assessment,
      scope,
    });

    const requestedBy = typeof body.requestedBy === "string" && body.requestedBy.trim() ? body.requestedBy.trim() : null;

    const common = {
      requestedBy,
      hsCode: assessment.hsCode,
      itemQuery: evidence.item.query,
      customsValue,
      importerType,
      mode,
      evidence: JSON.stringify(evidence),
    };

    // ---------------------------------------------------------------- brief --
    if (mode === "brief") {
      const drafted = await draftBriefing(evidence);
      const verification = verifyReport(drafted.text, evidence);

      const row = await prisma.aiReport.create({
        data: {
          ...common,
          model: drafted.model,
          report: drafted.text,
          verified: verification.ok,
          unsupported: JSON.stringify(verification.unsupported),
          inputTokens: drafted.inputTokens,
          outputTokens: drafted.outputTokens,
        },
        select: { id: true, createdAt: true },
      });

      return NextResponse.json({
        mode,
        reportId: row.id,
        createdAt: row.createdAt,
        model: drafted.model,
        report: drafted.text,
        evidence,
        verification,
      });
    }

    // ---------------------------------------------------------------- audit --
    const audit = await runAudit(evidence, scope);
    const checked = verifyFindings(audit.findings, audit.toolCalls);

    // Recorded BEFORE proposals are written, so the staged rows can cite the
    // audit that produced them and a reviewer can trace one back.
    const row = await prisma.aiReport.create({
      data: {
        ...common,
        model: audit.model,
        report: audit.summary,
        verified: checked.ok,
        unsupported: JSON.stringify([]),
        toolCalls: JSON.stringify(audit.toolCalls),
        findings: JSON.stringify(checked.kept),
        droppedFindings: JSON.stringify(checked.dropped),
        inputTokens: audit.inputTokens,
        outputTokens: audit.outputTokens,
      },
      select: { id: true, createdAt: true },
    });

    // Only verified findings may propose. This is the single write path out of
    // the AI layer and it reaches `staged_rows` only — never `obligations`.
    const proposals = await proposeFromFindings(checked.kept, {
      hsCode: assessment.hsCode,
      requestedBy,
      reportId: row.id,
    });
    if (proposals.created > 0) {
      await prisma.aiReport.update({
        where: { id: row.id },
        data: { proposalsCreated: proposals.created },
      });
    }

    return NextResponse.json({
      mode,
      reportId: row.id,
      createdAt: row.createdAt,
      model: audit.model,
      summary: audit.summary,
      findings: checked.kept,
      dropped: checked.dropped,
      proposals,
      evidence,
      stats: {
        turns: audit.turns,
        queries: audit.toolCalls.length,
        rowsRead: audit.toolCalls.reduce((n, c) => n + c.rowCount, 0),
        truncated: audit.truncated,
        inputTokens: audit.inputTokens,
        outputTokens: audit.outputTokens,
      },
      // The queries themselves, so "what did it actually look at" is answerable
      // on screen rather than only in the database.
      queries: audit.toolCalls.map((c) => ({
        name: c.name,
        input: c.input,
        rowCount: c.rowCount,
        ms: c.ms,
        error: c.error ?? null,
      })),
    });
  } catch (e) {
    // draftBriefing() and runAudit() already phrase their failures for an
    // officer to read.
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
