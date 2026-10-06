// The ingest queue.
//
// A user dropping in a hundred PDFs is asking for a lot of work: scanned
// documents run at two to four seconds a page, so a single 300-page Act is
// fifteen minutes. That must happen in the background, one document at a time,
// while the lookup screen stays usable — and it must be interruptible, because
// nobody should have to wait out a queue they started by mistake.
//
// The queue is deliberately in-process and single-threaded. Ingest is
// CPU-bound; running four at once on an officer's laptop makes every one of
// them slower and the machine unusable.

import { prisma } from "../db";
import type { ExtractedDocument } from "../pdf/types";
import { chunkDocument } from "./chunker";
import { classify } from "./classify";
import type { Classification } from "./classify";
import { extractAny } from "./formats";
import { runParsers } from "./parsers";

export type JobStage = "queued" | "extracting" | "ocr" | "parsing" | "ready" | "failed";

export interface JobProgress {
  sourceVersionId: string;
  filename: string;
  stage: JobStage;
  page: number;
  totalPages: number;
  /** True when this is a re-read of a document already in the library. */
  reread?: boolean;
  /** Set once the document has been classified. */
  docType?: string;
  reason?: string;
  stagedRows?: number;
  /** Words a second OCR pass rescued from a region the first pass dropped. */
  recoveredWords?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface QueuedJob {
  sourceVersionId: string;
  path: string;
  filename: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  title: string;
  /**
   * Read a document already in the library again, in place.
   *
   * For when the toolchain has improved rather than the document has changed —
   * the OCR recovery pass in lib/pdf/recover.ts went in after documents were
   * already loaded, and a table it can now rescue is no use to anybody sitting
   * in a PDF nobody will re-add. The source version is NOT touched: same row,
   * same id, same content hash, same effective dates. Only what was derived
   * from reading it is replaced.
   */
  reread?: boolean;
}

const queue: QueuedJob[] = [];
const progress = new Map<string, JobProgress>();
let running = false;
let cancelled = new Set<string>();

/** Add documents to the queue and start working if idle. */
export function enqueue(jobs: QueuedJob[]): void {
  for (const job of jobs) {
    queue.push(job);
    progress.set(job.sourceVersionId, {
      sourceVersionId: job.sourceVersionId,
      filename: job.filename,
      stage: "queued",
      page: 0,
      totalPages: 0,
      reread: job.reread ?? false,
      startedAt: Date.now(),
    });
  }
  void pump();
}

/** Everything the queue knows about, newest first. */
export function status(): { active: JobProgress[]; queued: number; working: boolean } {
  return {
    active: [...progress.values()].sort((a, b) => b.startedAt - a.startedAt),
    queued: queue.length,
    working: running,
  };
}

/** Stop a document that has not finished. Its file and row stay; nothing is deleted. */
export function cancel(sourceVersionId: string): void {
  cancelled.add(sourceVersionId);
  const idx = queue.findIndex((j) => j.sourceVersionId === sourceVersionId);
  if (idx >= 0) queue.splice(idx, 1);
}

/** Drop finished entries from the progress list. */
export function clearFinished(): void {
  for (const [id, p] of progress) {
    if (p.stage === "ready" || p.stage === "failed") progress.delete(id);
  }
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      if (cancelled.has(job.sourceVersionId)) continue;
      await processOne(job);
    }
  } finally {
    running = false;
  }
}

function update(id: string, patch: Partial<JobProgress>): void {
  const current = progress.get(id);
  if (current) progress.set(id, { ...current, ...patch });
}

async function setStatus(id: string, stage: JobStage, extra: Record<string, unknown> = {}): Promise<void> {
  update(id, { stage });
  await prisma.sourceVersion.update({
    where: { id },
    data: { ingestStatus: stage, ...extra },
  });
}

async function processOne(job: QueuedJob): Promise<void> {
  const id = job.sourceVersionId;
  const controller = new AbortController();

  try {
    await setStatus(id, "extracting");

    const doc = await extractAny(job.path, {
      signal: controller.signal,
      onProgress: (stage, page, total) => {
        if (cancelled.has(id)) controller.abort();
        update(id, { stage: stage === "ocr" ? "ocr" : "extracting", page, totalPages: total });
      },
    });

    if (cancelled.has(id)) throw new Error("Cancelled");

    await setStatus(id, "parsing", {
      pageCount: doc.pageCount,
      meanOcrConfidence: doc.meanOcrConfidence,
    });
    update(id, { recoveredWords: doc.recoveredWords });

    const classification: Classification = classify(doc.pageText, doc.method === "ocr", {
      tabular: doc.method === "xlsx" || doc.method === "csv",
    });
    update(id, { docType: classification.docType, reason: classification.reason });

    // On a re-read, what the last reading produced has to go before the new
    // reading replaces it, or the document ends up indexed twice.
    if (job.reread) await clearDerived(id);

    // Tier 1, and it applies to every document without exception: the text is
    // chunked and page-indexed, so it is searchable and every hit can deep-link
    // back to the page it came from.
    await storeChunks(id, doc);

    // Tier 2: only for documents shaped like something a parser understands,
    // and the output goes to staging — never to obligations.
    const staged = await runParsers({
      sourceVersionId: id,
      pages: doc.pages,
      pageText: doc.pageText,
      classification,
      effectiveFrom: job.effectiveFrom,
      title: job.title,
      locate: doc.locate,
    });

    await prisma.sourceVersion.update({
      where: { id },
      data: { docType: classification.docType, ingestStatus: "ready", ingestError: null },
    });
    update(id, { stage: "ready", stagedRows: staged, finishedAt: Date.now() });
  } catch (err) {
    const message = (err as Error).message || String(err);
    update(id, { stage: "failed", error: message, finishedAt: Date.now() });
    try {
      await prisma.sourceVersion.update({
        where: { id },
        data: { ingestStatus: "failed", ingestError: message },
      });
    } catch {
      // The row may not exist if the failure happened during creation.
    }
  } finally {
    cancelled.delete(id);
  }
}

/**
 * Throw away what the previous reading derived, and only that.
 *
 * Two things are deliberately kept. Chunks written by approval carry an
 * obligation's description and a person's decision behind it, so only the
 * extractor's own chunks go. And staged rows a reviewer has already ruled on —
 * approved or rejected — are the audit trail; re-reading the document does not
 * un-say what somebody said about it. Only pending proposals are cleared, and
 * the parsers will not re-propose what has already been ruled on.
 *
 * ParseRun rows are left alone entirely: they are a log of what each reading
 * found, and the point of a re-read is being able to compare the two.
 */
async function clearDerived(sourceVersionId: string): Promise<void> {
  await prisma.$transaction([
    prisma.chunk.deleteMany({ where: { sourceVersionId, origin: "extract" } }),
    prisma.stagedRow.deleteMany({ where: { sourceVersionId, status: "pending" } }),
  ]);
}

/**
 * Chunk a document's text for search.
 *
 * By paragraph rather than by page, so a hit returns the provision somebody was
 * looking for instead of the page it happens to sit on. Each chunk still keeps
 * its physical page number, so the citation can open the source PDF in the
 * right place. A Word or spreadsheet file arrives already chunked by its own
 * structure — a spreadsheet one row per chunk — and the "page" is the part of
 * the file the HTML view anchors.
 */
async function storeChunks(sourceVersionId: string, doc: ExtractedDocument): Promise<void> {
  const chunks = doc.chunks ?? chunkDocument(doc.pages, doc.pageText);
  const rows = chunks.map((c) => ({
    sourceVersionId,
    sectionRef: `p.${c.page}`,
    text: c.text,
    sourcePage: c.page,
    ocrConfidence: doc.meanOcrConfidence,
    // Marks this as the extractor's, and therefore replaceable by a re-read.
    origin: "extract",
  }));

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    await prisma.chunk.createMany({ data: rows.slice(i, i + BATCH) });
  }
}
