import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { ensureReady } from "@/lib/startup";
import { usage, formatBytes } from "@/lib/ingest/store";
import { supersede } from "@/lib/ingest/source";
import { previewRemoval, removeDocument } from "@/lib/ingest/remove";

// The document library: everything loaded, what came out of it, and how much of
// it was read. Listing, retiring and removing.
//
// Re-reading a document lives in /api/ingest, not here, even though it belongs
// to a document rather than to an upload. The reason is mechanical: the ingest
// queue is module state, Next bundles each route file separately, and a route
// that calls enqueue() from a different bundle than the one serving progress
// gets its own empty queue. The work happens; nobody can watch it. One module
// owns the queue and everything that touches it.

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureReady();

    const [versions, disk] = await Promise.all([
      prisma.sourceVersion.findMany({
        orderBy: { fetchedAt: "desc" },
        include: {
          parseRuns: { orderBy: { ranAt: "desc" }, take: 1 },
          supersedes: { select: { id: true, title: true } },
          _count: { select: { obligations: true, conditions: true, amendments: true, chunks: true } },
        },
      }),
      Promise.resolve(usage()),
    ]);

    const pending = await prisma.stagedRow.groupBy({
      by: ["sourceVersionId"],
      where: { status: "pending" },
      _count: { _all: true },
    });
    const pendingBy = new Map(pending.map((p) => [p.sourceVersionId, p._count._all]));

    return NextResponse.json({
      disk: { ...disk, human: formatBytes(disk.bytes) },
      documents: versions.map((v) => {
        const run = v.parseRuns[0];
        return {
          id: v.id,
          title: v.title,
          issuer: v.issuer,
          docType: v.docType,
          sourceFile: v.sourceFile,
          originalFilename: v.originalFilename,
          pageCount: v.pageCount,
          ingestStatus: v.ingestStatus,
          ingestError: v.ingestError,
          meanOcrConfidence: v.meanOcrConfidence,
          addedBy: v.addedBy,
          effectiveFrom: v.effectiveFrom,
          effectiveTo: v.effectiveTo,
          supersedes: v.supersedes,
          fetchedAt: v.fetchedAt,
          counts: {
            obligations: v._count.obligations,
            conditions: v._count.conditions,
            amendments: v._count.amendments,
            chunks: v._count.chunks,
            pendingReview: pendingBy.get(v.id) ?? 0,
          },
          coverage: run
            ? {
                parserId: run.parserId,
                linesSeen: run.linesSeen,
                rowsMatched: run.rowsMatched,
                coveragePct: run.coveragePct,
                notes: run.notes,
              }
            : null,
        };
      }),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * Retire an older version by pointing a newer one at it.
 *
 * The only correct way to replace a tariff: the old rows keep their dates and
 * simply stop applying from the new version's start, so a declaration filed
 * last March is still assessed against the rules in force last March. Nothing
 * is deleted — rule 3.
 */
export async function POST(req: Request) {
  try {
    await ensureReady();
    const { newVersionId, oldVersionId } = await req.json();
    if (!newVersionId || !oldVersionId) {
      return NextResponse.json({ error: "Both documents are required." }, { status: 400 });
    }
    if (newVersionId === oldVersionId) {
      return NextResponse.json({ error: "A document cannot supersede itself." }, { status: 400 });
    }

    const next = await prisma.sourceVersion.findUnique({ where: { id: newVersionId } });
    if (!next) return NextResponse.json({ error: "Replacement document not found." }, { status: 404 });

    await supersede(oldVersionId, newVersionId, next.effectiveFrom);
    return NextResponse.json({ ok: true, retiredFrom: next.effectiveFrom });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * Remove a document, or say what removing it would destroy.
 *
 * `?id=…` alone previews; `?id=…&confirm=1` does it. The two-step is the point
 * — this is the one operation in the app that destroys a source version, and
 * nobody should reach it without having been shown the rules that go with it.
 */
export async function DELETE(req: Request) {
  try {
    await ensureReady();
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "A document id is required." }, { status: 400 });

    if (url.searchParams.get("confirm") !== "1") {
      return NextResponse.json({ preview: await previewRemoval(id) });
    }

    const removed = await removeDocument(id);
    const disk = usage();
    return NextResponse.json({
      removed,
      disk: { files: disk.files, bytes: disk.bytes, human: formatBytes(disk.bytes) },
    });
  } catch (e) {
    const message = (e as Error).message;
    const status = /not in the library/.test(message)
      ? 404
      : /records this document/.test(message)
        ? 409
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
