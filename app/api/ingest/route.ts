import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { ensureReady } from "@/lib/startup";
import { ensureSourceVersion } from "@/lib/ingest/source";
import { storeUpload, usage, formatBytes, docsDir } from "@/lib/ingest/store";
import { enqueue, status, cancel, clearFinished } from "@/lib/ingest/worker";
import { pageCount } from "@/lib/pdf";

// Adding documents.
//
// Files are stored, registered as source versions, and queued. The reading
// itself happens in the background — a scanned Act is fifteen minutes of OCR,
// and the lookup screen has to stay usable throughout.
//
// The caller must supply `effectiveFrom`. No parser can reliably read a
// commencement date off a document, and guessing it silently breaks the rule
// that a declaration filed in March 2025 is assessed against the rules in force
// in March 2025. Asking is the only honest option.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Refuse anything that is not a PDF, by extension and by magic bytes. */
function looksLikePdf(name: string, data: Buffer): boolean {
  if (!/\.pdf$/i.test(name)) return false;
  return data.subarray(0, 5).toString("latin1") === "%PDF-";
}

export async function POST(req: Request) {
  try {
    await ensureReady();
    const form = await req.formData();

    const effectiveFromRaw = form.get("effectiveFrom");
    if (typeof effectiveFromRaw !== "string" || !effectiveFromRaw) {
      return NextResponse.json(
        { error: "A date the documents take effect from is required." },
        { status: 400 }
      );
    }
    const effectiveFrom = new Date(effectiveFromRaw);
    if (Number.isNaN(effectiveFrom.getTime())) {
      return NextResponse.json({ error: "That effective date could not be read." }, { status: 400 });
    }

    const effectiveToRaw = form.get("effectiveTo");
    const effectiveTo =
      typeof effectiveToRaw === "string" && effectiveToRaw ? new Date(effectiveToRaw) : null;

    const issuer = (form.get("issuer") as string) || "Unknown issuer";
    const addedBy = (form.get("addedBy") as string) || null;

    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return NextResponse.json({ error: "No files were attached." }, { status: 400 });
    }

    const accepted: {
      sourceVersionId: string;
      filename: string;
      pages: number;
      alreadyLoaded: boolean;
    }[] = [];
    const rejected: { filename: string; reason: string }[] = [];
    const queue: Parameters<typeof enqueue>[0] = [];

    for (const file of files) {
      const data = Buffer.from(await file.arrayBuffer());
      if (!looksLikePdf(file.name, data)) {
        rejected.push({ filename: file.name, reason: "Not a PDF." });
        continue;
      }

      const stored = await storeUpload(data, file.name);
      // The title is the filename until something better is known. A reviewer
      // can rename it in the library; inventing one from the text would put an
      // unverified string into every legal citation the document produces.
      const title = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim() || stored.name;

      let pages = 0;
      try {
        pages = await pageCount(stored.path);
      } catch (err) {
        // Report why. "Could not be opened" with no reason is useless to a user
        // deciding whether their file is corrupt or the app is broken.
        rejected.push({
          filename: file.name,
          reason: `Could not be opened as a PDF: ${(err as Error).message}`,
        });
        continue;
      }

      const src = await ensureSourceVersion({
        path: stored.path,
        title,
        issuer,
        // Provisional. The classifier sets the real type once the text is read,
        // and records the evidence for its choice.
        docType: "D",
        effectiveFrom,
        effectiveTo,
        sourceFile: stored.name,
        storedPath: stored.path,
        originalFilename: file.name,
        pageCount: pages,
        ingestStatus: "queued",
        addedBy,
      });

      accepted.push({
        sourceVersionId: src.sourceVersionId,
        filename: file.name,
        pages,
        alreadyLoaded: src.alreadyLoaded,
      });

      // Re-adding a document already loaded is a no-op, not a duplicate.
      // Sources are append-only and identified by content hash.
      if (!src.alreadyLoaded) {
        queue.push({
          sourceVersionId: src.sourceVersionId,
          path: stored.path,
          filename: file.name,
          effectiveFrom,
          effectiveTo,
          title,
        });
      }
    }

    if (queue.length > 0) enqueue(queue);

    const disk = usage();
    return NextResponse.json({
      accepted,
      rejected,
      queued: queue.length,
      skipped: accepted.filter((a) => a.alreadyLoaded).length,
      disk: { files: disk.files, bytes: disk.bytes, human: formatBytes(disk.bytes) },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * Read a document already in the library again, in place.
 *
 * For when the toolchain has improved rather than the document has changed —
 * the OCR recovery pass in lib/pdf/recover.ts went in after documents had been
 * loaded, and a table it can now rescue is no use to anybody sitting in a PDF
 * nobody will think to add a second time.
 *
 * The source version is not touched: same id, same content hash, same title,
 * same effective dates. Only what was derived from reading it is replaced, and
 * rule 3 protects the document and the rules drawn from it rather than the
 * search index built over it.
 *
 * This lives here rather than in /api/documents because the queue it feeds is
 * module state and Next gives each route file its own bundle. Enqueuing from
 * another route creates a second, invisible queue: the document is read, and
 * the progress panel shows nothing at all.
 */
export async function PATCH(req: Request) {
  try {
    await ensureReady();
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "A document id is required." }, { status: 400 });

    const version = await prisma.sourceVersion.findUnique({ where: { id } });
    if (!version) return NextResponse.json({ error: "Document not found." }, { status: 404 });

    const path = sourcePath(version.storedPath, version.sourceFile);
    if (!path) {
      return NextResponse.json(
        {
          error:
            "The original PDF for this document is no longer on disk, so it cannot be read again. " +
            "Add the file again to replace it.",
        },
        { status: 409 }
      );
    }

    enqueue([
      {
        sourceVersionId: version.id,
        path,
        filename: version.originalFilename ?? version.title,
        effectiveFrom: version.effectiveFrom,
        effectiveTo: version.effectiveTo,
        title: version.title,
        reread: true,
      },
    ]);

    return NextResponse.json({ ok: true, queued: version.id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * Where a document's PDF actually is.
 *
 * Two homes, as in app/api/doc/[file]: the writable per-user folder for
 * anything added in the app, and the read-only bundle for the four that ship
 * with it. A bundled document can be re-read as happily as any other.
 */
function sourcePath(storedPath: string | null, sourceFile: string | null): string | null {
  if (storedPath && existsSync(storedPath)) return storedPath;
  if (!sourceFile) return null;
  for (const dir of [docsDir(), join(process.cwd(), "public", "docs")]) {
    const candidate = join(dir, basename(sourceFile));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Progress for everything currently being read. Polled by the add screen. */
export async function GET() {
  const disk = usage();
  return NextResponse.json({
    ...status(),
    disk: { files: disk.files, bytes: disk.bytes, human: formatBytes(disk.bytes) },
  });
}

/** Cancel one document, or clear finished entries from the list. */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    cancel(id);
    return NextResponse.json({ cancelled: id });
  }
  clearFinished();
  return NextResponse.json({ cleared: true });
}
