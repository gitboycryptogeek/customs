import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { ensureReady } from "@/lib/startup";

// Previous requests, newest first.
//
// Two tables, one list. `lookups` is every assessment the engine produced;
// `ai_reports` is every briefing, audit and conversational answer. They are
// merged here rather than in the page so the page stays a renderer, and so
// "previous requests" means the same thing whichever kind you made.
//
// Deliberately excluded: `search_misses`. That is the alias-table backlog and it
// already has its own page, where it is a work queue rather than a history.

export const dynamic = "force-dynamic";

/** Newest N of each kind. Bounded — this list is for finding a recent request, not an archive. */
const LIMIT = 60;

export async function GET(req: Request) {
  try {
    await ensureReady();

    const url = new URL(req.url);
    const kind = url.searchParams.get("kind"); // "lookup" | "ai" | null for both

    const [lookups, reports] = await Promise.all([
      kind === "ai"
        ? []
        : prisma.lookup.findMany({
            orderBy: { createdAt: "desc" },
            take: LIMIT,
            select: {
              id: true,
              itemQuery: true,
              hsCode: true,
              description: true,
              resolvedVia: true,
              customsValue: true,
              importerType: true,
              total: true,
              totalBlocked: true,
              lineCount: true,
              flagCount: true,
              requestedBy: true,
              createdAt: true,
            },
          }),
      kind === "lookup"
        ? []
        : prisma.aiReport.findMany({
            orderBy: { createdAt: "desc" },
            take: LIMIT,
            // Never the evidence pack or the full report — this is a list. The
            // pack is large, and sending every one of them to render titles
            // would make the page slower the more it has to show.
            select: {
              id: true,
              mode: true,
              itemQuery: true,
              hsCode: true,
              customsValue: true,
              importerType: true,
              model: true,
              verified: true,
              proposalsCreated: true,
              inputTokens: true,
              outputTokens: true,
              requestedBy: true,
              createdAt: true,
            },
          }),
    ]);

    const items = [
      ...lookups.map((l) => ({
        kind: "lookup" as const,
        id: l.id,
        createdAt: l.createdAt,
        itemQuery: l.itemQuery,
        hsCode: l.hsCode,
        description: l.description,
        resolvedVia: l.resolvedVia,
        customsValue: l.customsValue === null ? null : Number(l.customsValue),
        importerType: l.importerType,
        total: l.total === null ? null : Number(l.total),
        totalBlocked: l.totalBlocked,
        lineCount: l.lineCount,
        flagCount: l.flagCount,
        requestedBy: l.requestedBy,
      })),
      ...reports.map((r) => ({
        kind: "ai" as const,
        id: r.id,
        createdAt: r.createdAt,
        mode: r.mode,
        itemQuery: r.itemQuery,
        hsCode: r.hsCode || null,
        customsValue: r.customsValue === null ? null : Number(r.customsValue),
        importerType: r.importerType,
        model: r.model,
        verified: r.verified,
        proposalsCreated: r.proposalsCreated,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        requestedBy: r.requestedBy,
      })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return NextResponse.json({ items: items.slice(0, LIMIT) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
