import { NextResponse } from "next/server";

import { assess } from "@/lib/assess";
import { interpret } from "@/lib/interpret";
import { resolveHsCode, searchLaw } from "@/lib/search";
import { ensureReady } from "@/lib/startup";
import { prisma } from "@/lib/db";
import { aiStatus } from "@/lib/ai/config";
import { buildEvidence } from "@/lib/ai/evidence";
import { answerQuestion, MAX_HISTORY_TURNS, type ChatGrounding, type ChatTurn } from "@/lib/ai/chat";
import { verifyReport } from "@/lib/ai/verify";
import { documentScope, scopeFilter } from "@/lib/ai/scope";
import { redactTerm } from "@/lib/ai/redact";

// Conversational mode, grounded per turn.
//
// Like /api/ai/report this rebuilds the entire factual basis here on the server
// and refuses to accept one from the client — the grounding is both what the
// model may use and what its answer is checked against, so a caller-supplied one
// would defeat both at once. The client sends a question and the prior turns'
// TEXT only; no figures, no evidence, no assessment travels up from the browser.
//
// The history is not evidence either. It is replayed for continuity of phrasing,
// and the grounding is rebuilt from the engine every turn, so a figure cannot
// survive from turn 3 into turn 7 unless the engine produced it again.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** How many law passages to ground a general (non-assessable) question on. */
const PASSAGES_FOR_GENERAL = 8;

export async function POST(req: Request) {
  try {
    await ensureReady();

    const status = aiStatus();
    if (!status.ready) {
      return NextResponse.json(
        {
          error: status.configured
            ? "AI mode is switched off. Turn it on under Settings."
            : "No API key is configured. Add one under Settings.",
        },
        { status: 400 }
      );
    }

    const body = await req.json();

    const rawQuestion: unknown = body.question;
    if (!rawQuestion || typeof rawQuestion !== "string" || !rawQuestion.trim()) {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }

    // Scrubbed before it is used for anything, including the log. The chat box is
    // free text and is the likeliest place in the whole app for somebody to paste
    // a KRA PIN or an entry number.
    const question = redactTerm(rawQuestion.trim()).slice(0, 2000);

    const history: ChatTurn[] = Array.isArray(body.history)
      ? body.history
          .filter(
            (t: unknown): t is ChatTurn =>
              !!t &&
              typeof t === "object" &&
              ((t as ChatTurn).role === "user" || (t as ChatTurn).role === "assistant") &&
              typeof (t as ChatTurn).text === "string"
          )
          .slice(-MAX_HISTORY_TURNS)
          .map((t: ChatTurn) => ({ role: t.role, text: redactTerm(t.text).slice(0, 4000) }))
      : [];

    const scope = await documentScope();

    // --- Try for a real assessment first ------------------------------------
    const said = interpret(question);
    const overrideValue = body.customsValue === "" || body.customsValue == null ? null : Number(body.customsValue);
    const customsValue = overrideValue !== null && Number.isFinite(overrideValue) ? overrideValue : said.customsValue;
    const importerType = (typeof body.importerType === "string" && body.importerType) || said.importerType;

    const resolution = said.itemQuery.trim() ? await resolveHsCode(said.itemQuery) : { hsCode: null, method: "none" };

    let grounding: ChatGrounding;
    let hsCode: string | null = null;

    if (resolution.hsCode && customsValue !== null && Number.isFinite(customsValue) && customsValue >= 0) {
      const assessment = await assess(resolution.hsCode, customsValue, importerType);
      hsCode = assessment.hsCode;
      const pack = await buildEvidence({
        itemQuery: said.itemQuery,
        resolvedVia: resolution.method,
        customsValue,
        importerType,
        assessment,
        scope,
      });
      grounding = {
        question,
        pack,
        passages: pack.passages,
        documentsLoaded: pack.documentsLoaded.map((d) => ({ title: d.title, issuer: d.issuer, docType: d.docType })),
        withheldDocuments: pack.withheldDocuments,
        rulesAsAt: pack.rulesAsAt,
        noAssessmentReason: null,
      };
    } else {
      // No assessable item, or no value. Ground on the law itself and say why
      // there are no figures — an officer asking "what is IDF charged on?" wants
      // the provision, not an apology.
      const filter = scopeFilter(scope);
      const hits = await searchLaw(question, PASSAGES_FOR_GENERAL, filter.sourceVersionId?.in ?? null);
      const loaded = await prisma.sourceVersion.findMany({
        where: scope.allowed ? { id: { in: scope.allowed } } : undefined,
        select: { title: true, issuer: true, docType: true },
      });

      grounding = {
        question,
        pack: null,
        passages: hits.map((h) => ({
          sourceTitle: h.sourceTitle,
          hsCode: h.hsCode,
          page: h.page,
          text: h.snippet,
        })),
        documentsLoaded: loaded,
        withheldDocuments: scope.withheldCount,
        rulesAsAt: new Date().toISOString().slice(0, 10),
        noAssessmentReason: !resolution.hsCode
          ? "No HS code matched an item in this question, so the engine produced no charges. Answer from the law passages only."
          : "No customs value was given, so the engine could not compute charges. Answer from the law passages only and say a value is needed for figures.",
      };
    }

    const answer = await answerQuestion(grounding, history);

    // Checked against the grounding the same way a briefing is. Only meaningful
    // when there is a pack — with no assessment there are no permitted figures,
    // and the check for that case is that the model quoted none.
    const verification = grounding.pack
      ? verifyReport(answer.text, grounding.pack)
      : verifyReport(answer.text, {
          // A pack-shaped shell holding only the passages, so any figure the
          // model wrote must have come from the law text it was shown.
          item: { query: question, hsCode: "", description: null, resolvedVia: "none" },
          declared: { customsValue: "", importerType: "" },
          charges: [],
          total: null,
          totalBlocked: true,
          flags: [],
          conditions: [],
          passages: grounding.passages,
          withheldDocuments: grounding.withheldDocuments,
          documentsLoaded: grounding.documentsLoaded.map((d) => ({
            ...d,
            effectiveFrom: "",
            effectiveTo: null,
          })),
          rulesAsAt: grounding.rulesAsAt,
        });

    const requestedBy =
      typeof body.requestedBy === "string" && body.requestedBy.trim() ? body.requestedBy.trim() : null;

    // Logged into the same append-only table as every other AI call, so History
    // shows one list and an unverified answer stays findable.
    const row = await prisma.aiReport.create({
      data: {
        requestedBy,
        hsCode: hsCode ?? "",
        itemQuery: question,
        customsValue: customsValue !== null && Number.isFinite(customsValue) ? customsValue : 0,
        importerType,
        mode: "chat",
        evidence: JSON.stringify(grounding),
        model: answer.model,
        report: answer.text,
        verified: verification.ok,
        unsupported: JSON.stringify(verification.unsupported),
        inputTokens: answer.inputTokens,
        outputTokens: answer.outputTokens,
      },
      select: { id: true, createdAt: true },
    });

    return NextResponse.json({
      mode: "chat",
      reportId: row.id,
      createdAt: row.createdAt,
      model: answer.model,
      answer: answer.text,
      verification,
      grounded: Boolean(grounding.pack),
      noAssessmentReason: grounding.noAssessmentReason,
      hsCode,
      withheldDocuments: grounding.withheldDocuments,
      usage: {
        inputTokens: answer.inputTokens,
        outputTokens: answer.outputTokens,
        cacheReadTokens: answer.cacheReadTokens,
        cacheWriteTokens: answer.cacheWriteTokens,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
