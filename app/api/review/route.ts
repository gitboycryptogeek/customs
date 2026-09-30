import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { ensureReady } from "@/lib/startup";
import { approve, reject } from "@/lib/ingest/review";

// The review queue.
//
// GET lists what parsers have proposed; POST approves or rejects. Nothing here
// affects an assessment until a person approves it, and an approved row records
// who approved it.

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await ensureReady();
    const url = new URL(req.url);
    const sourceVersionId = url.searchParams.get("document") ?? undefined;
    const kind = url.searchParams.get("kind") ?? undefined;
    const status = url.searchParams.get("status") ?? "pending";
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    const where = { status, ...(sourceVersionId ? { sourceVersionId } : {}), ...(kind ? { kind } : {}) };

    const [rows, total, byDocument] = await Promise.all([
      prisma.stagedRow.findMany({
        where,
        // Least confident first: the rows most likely to need a correction are
        // the ones worth a person's attention, and a queue that opens with
        // hundreds of clean rows trains people to click approve.
        orderBy: [{ confidence: "asc" }, { sourcePage: "asc" }],
        skip: offset,
        take: limit,
        include: {
          sourceVersion: { select: { id: true, title: true, sourceFile: true, docType: true } },
        },
      }),
      prisma.stagedRow.count({ where }),
      prisma.stagedRow.groupBy({
        by: ["sourceVersionId", "kind"],
        where: { status: "pending" },
        _count: { _all: true },
      }),
    ]);

    return NextResponse.json({
      total,
      offset,
      rows: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        parserId: r.parserId,
        confidence: r.confidence,
        snippet: r.snippet,
        sourcePage: r.sourcePage,
        payload: JSON.parse(r.payload),
        document: r.sourceVersion,
      })),
      pendingByDocument: byDocument.map((g) => ({
        sourceVersionId: g.sourceVersionId,
        kind: g.kind,
        count: g._count._all,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    await ensureReady();
    const body = await req.json();
    const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
    const reviewedBy: string = (body.reviewedBy || "").trim();
    const action: string = body.action;

    if (ids.length === 0) {
      return NextResponse.json({ error: "Select at least one row." }, { status: 400 });
    }
    if (!reviewedBy) {
      // Rule 2 again: a figure has to be traceable, and that includes to the
      // person who accepted it. An anonymous approval is not an audit trail.
      return NextResponse.json(
        { error: "Enter your name — approvals are recorded against a person." },
        { status: 400 }
      );
    }

    if (action === "approve") {
      return NextResponse.json(await approve(ids, reviewedBy, body.edits ?? {}));
    }
    if (action === "reject") {
      return NextResponse.json(await reject(ids, reviewedBy));
    }
    return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
