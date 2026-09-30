// Where source documents live on disk.
//
// The four that ship with the app sit inside the read-only bundle. Anything a
// user adds cannot, so it goes to a writable per-user folder that survives
// updates — DOCS_DIR, set by electron/main.js. Files are named by their content
// hash, which makes re-adding the same document a no-op at the filesystem level
// as well as in the database, and means two documents with the same name never
// collide.

import { createWriteStream, existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { sha256Buffer } from "../pdf";

/** Absolute path to the writable documents folder, created if missing. */
export function docsDir(): string {
  const dir = process.env.DOCS_DIR || join(process.cwd(), "docs-store");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export interface StoredFile {
  /** Filename under the docs folder — this is what `sourceFile` holds. */
  name: string;
  path: string;
  bytes: number;
  contentHash: string;
  /** True when an identical file was already stored. */
  existed: boolean;
}

/**
 * Store an uploaded document, named by its content hash.
 *
 * Written to a temporary name and renamed into place, so an interrupted upload
 * can never leave a half-written PDF that later looks like a real document and
 * parses into nonsense.
 */
export async function storeUpload(data: Buffer, originalName: string): Promise<StoredFile> {
  const dir = docsDir();
  const hash = sha256Buffer(data);
  const ext = extname(originalName).toLowerCase() === ".pdf" ? ".pdf" : ".pdf";
  const name = `${hash}${ext}`;
  const path = join(dir, name);

  if (existsSync(path)) {
    return { name, path, bytes: statSync(path).size, contentHash: hash, existed: true };
  }

  const tmp = join(dir, `.${hash}.part`);
  await writeFile(tmp, data);
  await rename(tmp, path);
  return { name, path, bytes: data.length, contentHash: hash, existed: false };
}

/** Same, for a file arriving as a stream rather than a buffer. */
export async function storeStream(stream: Readable, contentHash: string): Promise<StoredFile> {
  const dir = docsDir();
  const name = `${contentHash}.pdf`;
  const path = join(dir, name);
  if (existsSync(path)) {
    return { name, path, bytes: statSync(path).size, contentHash, existed: true };
  }
  const tmp = join(dir, `.${contentHash}.part`);
  await pipeline(stream, createWriteStream(tmp));
  await rename(tmp, path);
  return { name, path, bytes: statSync(path).size, contentHash, existed: false };
}

/** Remove a stored file. Only for cleaning up a failed ingest — sources are append-only. */
export async function discard(name: string): Promise<void> {
  const path = join(docsDir(), basename(name));
  if (existsSync(path)) await unlink(path);
}

/** Total bytes held in the documents folder, for the disk figure in the library. */
export function usage(): { files: number; bytes: number } {
  const dir = docsDir();
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const s = statSync(join(dir, entry));
    if (!s.isFile()) continue;
    files++;
    bytes += s.size;
  }
  return { files, bytes };
}

/** Human-readable size, for the UI. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
