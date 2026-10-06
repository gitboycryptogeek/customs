import { createReadStream, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { CONTENT_TYPES, formatOf } from "@/lib/ingest/formats";
import { readParts } from "@/lib/office";
import { renderPartsHtml } from "@/lib/office/render";

// Serve a source PDF so a citation can deep-link to its page.
//
// Two places hold documents and both have to work through one URL:
//   - the four that ship with the app, inside the read-only bundle;
//   - anything a user adds, in a writable per-user folder (DOCS_DIR, set by
//     electron/main.js) — the bundle cannot be written to.
//
// Range requests are honoured because PDF viewers use them: without a 206 the
// viewer downloads the whole file before it can show page 460, and the CET is
// 577 pages. That is the difference between a citation opening instantly and a
// citation appearing broken.
//
// Word and spreadsheet files are a different matter: a browser shows neither,
// so they are rendered to an HTML page with one `page=N` anchor per part (see
// lib/office/render.ts). `?download=1` serves the original file instead.

export const dynamic = "force-dynamic";

/** Where user-added documents live. Absolute; the server's cwd is inside the bundle. */
function userDocsDir(): string | null {
  return process.env.DOCS_DIR || null;
}

/** Bundled documents, served from the app's own public directory. */
function bundledDocsDir(): string {
  return join(process.cwd(), "public", "docs");
}

/**
 * Resolve a requested filename to a real file.
 *
 * The name is reduced to its basename first. It comes from the database rather
 * than from the user, but a stored value is still not a safe path — one bad row
 * or one careless loader should not be able to read outside the docs folders.
 */
function resolveDoc(name: string): string | null {
  const safe = basename(name);
  if (!safe || safe.startsWith(".") || !formatOf(safe)) return null;

  for (const dir of [userDocsDir(), bundledDocsDir()]) {
    if (!dir) continue;
    const candidate = join(dir, safe);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ file: string }> }
) {
  const { file } = await params;
  const path = resolveDoc(decodeURIComponent(file));
  if (!path) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  const format = formatOf(path)!;
  const download = new URL(req.url).searchParams.has("download");

  if (format !== "pdf" && !download) return officeView(path);

  const { size } = statSync(path);
  const headers: Record<string, string> = {
    "content-type": CONTENT_TYPES[format],
    "accept-ranges": "bytes",
    // Sources are append-only and addressed by name, so a served file never
    // changes underneath a cached copy.
    "cache-control": "private, max-age=3600",
    "content-disposition": download
      ? attachment((await originalName(basename(path))) ?? basename(path))
      : `inline; filename="${basename(path)}"`,
  };

  const range = req.headers.get("range");
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      return new NextResponse(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    const stream = createReadStream(path, { start, end });
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  }

  const stream = createReadStream(path);
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: { ...headers, "content-length": String(size) },
  });
}

/**
 * A Word or spreadsheet file as a page, titled with the name it was added under.
 * The file is untrusted: the renderer escapes everything, and the CSP forbids
 * any script or outside load even if something got through.
 */
async function officeView(path: string): Promise<Response> {
  const name = basename(path);
  const title = (await originalName(name)) ?? name;
  try {
    const parts = await readParts(path, formatOf(path) as "docx" | "xlsx" | "csv");
    // Relative to /api/doc/, and the stored name is a content hash: nothing to escape.
    const html = renderPartsHtml(parts, title, `${name}?download=1`);
    return new NextResponse(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, max-age=3600",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: `This file could not be read: ${(err as Error).message}` }, { status: 422 });
  }
}

/** The filename a document was added under, when the library knows it. */
async function originalName(stored: string): Promise<string | null> {
  try {
    const version = await prisma.sourceVersion.findFirst({
      where: { sourceFile: stored },
      select: { originalFilename: true },
    });
    return version?.originalFilename ?? null;
  } catch {
    // The library being unreadable is no reason not to serve the file.
    return null;
  }
}

/** A download header that survives a non-ASCII filename. */
function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
