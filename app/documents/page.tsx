"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

// The document library, and the screen for adding more.
//
// Two things a user needs to see and could not before: what the app has read,
// and how much of each document it actually managed to read. Coverage is shown
// against the CET's ~99% because a number on its own means nothing — knowing a
// new schedule parsed at 62% is what tells you to go and look at it.

interface Coverage {
  parserId: string;
  linesSeen: number;
  rowsMatched: number;
  coveragePct: number;
  notes: string | null;
}

interface Doc {
  id: string;
  title: string;
  issuer: string;
  docType: string;
  sourceFile: string | null;
  originalFilename: string | null;
  pageCount: number | null;
  ingestStatus: string;
  ingestError: string | null;
  meanOcrConfidence: number | null;
  addedBy: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  supersedes: { id: string; title: string } | null;
  counts: { obligations: number; conditions: number; amendments: number; chunks: number; pendingReview: number };
  coverage: Coverage | null;
}

interface Removal {
  id: string;
  title: string;
  obligations: number;
  conditions: number;
  amendments: number;
  chunks: number;
  stagedRows: number;
  reviewed: boolean;
  blockedBy: { id: string; title: string } | null;
  fileRemoved: boolean;
}

interface Job {
  sourceVersionId: string;
  filename: string;
  stage: string;
  reread?: boolean;
  page: number;
  totalPages: number;
  docType?: string;
  reason?: string;
  stagedRows?: number;
  recoveredWords?: number;
  error?: string;
}

const DOC_TYPE_LABEL: Record<string, string> = {
  A: "Tariff schedule",
  B: "Scan, little text",
  C: "Amending Act",
  D: "Notice or Act",
};

const STAGE_LABEL: Record<string, string> = {
  queued: "Waiting",
  extracting: "Reading",
  ocr: "Reading the scan",
  parsing: "Looking for rules",
  ready: "Done",
  failed: "Failed",
};

function fmtDate(d: string | null): string {
  return d ? new Date(d).toISOString().slice(0, 10) : "—";
}

export default function Documents() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [disk, setDisk] = useState<{ human: string; files: number } | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Add form.
  //
  // The effective date starts EMPTY and must not be given a default. Today's
  // date pre-filled is not a prompt, it is an answer — the field is required,
  // so a user who does not think about it has silently declared that a memo
  // dated last September takes effect today, and rule 3 means that date is then
  // in the record for good. A blank box that blocks the button is the whole
  // safeguard here.
  const [files, setFiles] = useState<File[]>([]);
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [issuer, setIssuer] = useState("");
  const [addedBy, setAddedBy] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Removal is two-step by design: the first click asks the server what would
  // be destroyed and shows it, the second does it. Nobody deletes a source
  // version without having read the count of rules that go with it.
  const [pendingRemoval, setPendingRemoval] = useState<Removal | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadDocs = useCallback(async () => {
    try {
      const res = await fetch("/api/documents");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load the library.");
      setDocs(data.documents);
      setDisk(data.disk);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/ingest");
      const data = await res.json();
      setJobs(data.active ?? []);
      setWorking(Boolean(data.working) || (data.queued ?? 0) > 0);
      return Boolean(data.working) || (data.queued ?? 0) > 0;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    loadDocs();
    loadJobs();
  }, [loadDocs, loadJobs]);

  // Poll while anything is being read, then refresh the library once and stop.
  // Reading a scan takes minutes; a static screen looks broken.
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(async () => {
      const stillWorking = await loadJobs();
      if (!stillWorking) {
        await loadDocs();
        clearInterval(timer);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [working, loadJobs, loadDocs]);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const pdfs = Array.from(list).filter((f) => /\.pdf$/i.test(f.name));
    setFiles((prev) => [...prev, ...pdfs]);
    setNotice(
      list.length > pdfs.length
        ? `${list.length - pdfs.length} file${list.length - pdfs.length === 1 ? "" : "s"} skipped — only PDFs can be read.`
        : null
    );
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (files.length === 0) return;
    if (!effectiveFrom) {
      setError("Set the date these documents take effect from. It cannot be changed later.");
      return;
    }
    setError(null);
    setNotice(null);
    setUploading(true);
    try {
      const body = new FormData();
      for (const f of files) body.append("files", f);
      body.append("effectiveFrom", effectiveFrom);
      if (issuer) body.append("issuer", issuer);
      if (addedBy) body.append("addedBy", addedBy);

      const res = await fetch("/api/ingest", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed.");

      const parts: string[] = [];
      if (data.queued) parts.push(`${data.queued} queued for reading`);
      if (data.skipped) parts.push(`${data.skipped} already loaded`);
      if (data.rejected?.length) parts.push(`${data.rejected.length} rejected`);
      setNotice(parts.join(" · ") || "Nothing to do.");
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
      setWorking(true);
      loadDocs();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  /** Read a document already in the library again, with the current toolchain. */
  async function reread(d: Doc) {
    setError(null);
    setNotice(null);
    setBusyId(d.id);
    try {
      // /api/ingest, not /api/documents: the queue is module state and each
      // route file is its own bundle, so only the route that serves progress
      // can start work anybody will see.
      const res = await fetch("/api/ingest", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: d.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not queue that document.");
      setNotice(`Reading "${d.title}" again.`);
      setWorking(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  /** Step one: ask what removing this document would destroy. */
  async function askRemove(d: Doc) {
    setError(null);
    setNotice(null);
    setBusyId(d.id);
    try {
      const res = await fetch(`/api/documents?id=${encodeURIComponent(d.id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not read that document.");
      setPendingRemoval(data.preview);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  /** Step two: do it. */
  async function confirmRemove(r: Removal) {
    setError(null);
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/documents?id=${encodeURIComponent(r.id)}&confirm=1`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not remove that document.");
      setPendingRemoval(null);
      setNotice(`Removed "${r.title}" and everything read from it.`);
      await loadDocs();
    } catch (err) {
      setError((err as Error).message);
      setPendingRemoval(null);
    } finally {
      setBusyId(null);
    }
  }

  const totalPending = docs.reduce((n, d) => n + d.counts.pendingReview, 0);

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>Documents</h1>
        <p>
          Everything the app has read, and how much of each document it managed to read.{" "}
          <Link href="/">Back to lookup</Link> · <Link href="/misses">Unmatched searches</Link>
          {totalPending > 0 && (
            <>
              {" · "}
              <Link href="/review">
                <strong>{totalPending} suggestion{totalPending === 1 ? "" : "s"} waiting for review</strong>
              </Link>
            </>
          )}
        </p>
      </header>

      {error && <div className="results"><div className="error">{error}</div></div>}

      {/* ---------- Confirm removal ---------- */}
      {pendingRemoval && (
        <div className="results">
          <div className="card confirm">
            <p className="section-title">Remove “{pendingRemoval.title}”?</p>
            {pendingRemoval.blockedBy ? (
              <>
                <p>
                  <strong>“{pendingRemoval.blockedBy.title}”</strong> records this document as the
                  version it replaced. Removing it would erase what replaced what, so it is not
                  offered here. Remove that document first if you really mean to.
                </p>
                <div className="actions">
                  <button type="button" className="go" onClick={() => setPendingRemoval(null)}>
                    Keep it
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>This deletes the document and everything read from it:</p>
                <ul className="losses">
                  {pendingRemoval.obligations > 0 && (
                    <li><strong>{pendingRemoval.obligations} rate{pendingRemoval.obligations === 1 ? "" : "s"}</strong> — any assessment citing them stops being reproducible</li>
                  )}
                  {pendingRemoval.conditions > 0 && (
                    <li>{pendingRemoval.conditions} condition{pendingRemoval.conditions === 1 ? "" : "s"}</li>
                  )}
                  {pendingRemoval.amendments > 0 && (
                    <li>{pendingRemoval.amendments} amendment{pendingRemoval.amendments === 1 ? "" : "s"}</li>
                  )}
                  {pendingRemoval.chunks > 0 && (
                    <li>{pendingRemoval.chunks} searchable passage{pendingRemoval.chunks === 1 ? "" : "s"}</li>
                  )}
                  {pendingRemoval.stagedRows > 0 && (
                    <li>{pendingRemoval.stagedRows} suggestion{pendingRemoval.stagedRows === 1 ? "" : "s"}, reviewed or not</li>
                  )}
                  <li>{pendingRemoval.fileRemoved ? "the stored PDF" : "the library entry only — the PDF ships with the app and stays"}</li>
                </ul>
                {pendingRemoval.reviewed && (
                  <p className="warn">
                    Somebody approved or rejected suggestions from this document. That decision, and
                    the record of who made it, goes with it.
                  </p>
                )}
                {pendingRemoval.obligations > 0 && (
                  <p className="warn">
                    Documents are normally retired, not deleted, so a declaration filed last March can
                    still be assessed against the rules in force last March. If this document was
                    replaced by a newer one, retire it instead.
                  </p>
                )}
                <div className="actions">
                  <button
                    type="button"
                    className="go danger"
                    disabled={busyId === pendingRemoval.id}
                    onClick={() => confirmRemove(pendingRemoval)}
                  >
                    {busyId === pendingRemoval.id ? "Removing…" : "Remove permanently"}
                  </button>
                  <button type="button" className="linkbtn" onClick={() => setPendingRemoval(null)}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---------- Add ---------- */}
      <div className="card">
        <p className="section-title">Add documents</p>
        <form onSubmit={upload}>
          <div
            className={`dropzone ${dragging ? "over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
            onClick={() => fileInput.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileInput.current?.click(); }}
          >
            <strong>Drop PDFs here, or click to choose them.</strong>
            <span>
              A hundred at a time is fine. Documents with a text layer take seconds; a scan is read a
              page at a time, at roughly two to four seconds a page.
            </span>
            <input
              ref={fileInput}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              hidden
              onChange={(e) => addFiles(e.target.files)}
            />
          </div>

          {files.length > 0 && (
            <div className="filelist">
              <p>
                {files.length} file{files.length === 1 ? "" : "s"} ready
                <button type="button" className="linkbtn" onClick={() => setFiles([])}>clear</button>
              </p>
              <ul>
                {files.slice(0, 8).map((f, i) => <li key={i}>{f.name}</li>)}
                {files.length > 8 && <li>…and {files.length - 8} more</li>}
              </ul>
            </div>
          )}

          <div className="overrides">
            <div>
              <label className="optlabel" htmlFor="ef">In force from</label>
              <input
                id="ef"
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="optlabel" htmlFor="iss">Issued by <span>(optional)</span></label>
              <input id="iss" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="e.g. Kenya Revenue Authority" />
            </div>
            <div>
              <label className="optlabel" htmlFor="by">Your name <span>(optional)</span></label>
              <input id="by" value={addedBy} onChange={(e) => setAddedBy(e.target.value)} placeholder="recorded against these documents" />
            </div>
          </div>

          <p className="hint">
            The date is asked for because no parser can read a commencement date reliably, and a
            declaration filed in March 2025 has to be assessed against the rules in force in March 2025.
            It is left blank on purpose: take it off the document itself — the date it commences, not
            the day you are loading it — because it cannot be corrected afterwards.
          </p>

          <div className="actions">
            <button
              className="go"
              type="submit"
              disabled={uploading || files.length === 0 || !effectiveFrom}
            >
              {uploading ? "Uploading…" : `Add ${files.length || ""} document${files.length === 1 ? "" : "s"}`}
            </button>
            {files.length > 0 && !effectiveFrom && (
              <span className="aside">Set the date these take effect from before adding them.</span>
            )}
            {notice && <span className="aside">{notice}</span>}
          </div>
        </form>
      </div>

      {/* ---------- In progress ---------- */}
      {jobs.length > 0 && (
        <div className="results">
          <div className="card">
            <p className="section-title">Being read</p>
            {jobs.map((j) => (
              <div key={j.sourceVersionId} className={`job ${j.stage}`}>
                <div className="jobhead">
                  <span className="jobname">
                    {j.filename}
                    {j.reread && <span className="tag">reading again</span>}
                  </span>
                  <span className="jobstage">{STAGE_LABEL[j.stage] ?? j.stage}</span>
                </div>
                {j.totalPages > 0 && j.stage !== "ready" && j.stage !== "failed" && (
                  <>
                    <div className="bar"><div className="fill" style={{ width: `${Math.round((j.page / j.totalPages) * 100)}%` }} /></div>
                    <div className="jobnote">page {j.page} of {j.totalPages}</div>
                  </>
                )}
                {j.stage === "ready" && (
                  <div className="jobnote">
                    {j.docType && <><b>{DOC_TYPE_LABEL[j.docType] ?? j.docType}.</b> </>}
                    {j.reason}
                    {typeof j.stagedRows === "number" && j.stagedRows > 0 && (
                      <> {j.stagedRows} suggestion{j.stagedRows === 1 ? "" : "s"} went to <Link href="/review">review</Link>.</>
                    )}
                    {/*
                      Said out loud because it means the scan had a region OCR
                      dropped whole — usually a table. It was read on a second
                      pass, and a reader deciding whether to trust the document
                      should know that happened.
                    */}
                    {typeof j.recoveredWords === "number" && j.recoveredWords > 0 && (
                      <> {j.recoveredWords} word{j.recoveredWords === 1 ? "" : "s"} came from a region
                      the first OCR pass skipped — worth checking against the original.</>
                    )}
                  </div>
                )}
                {j.stage === "failed" && <div className="jobnote err">{j.error}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------- Library ---------- */}
      <div className="results">
        <div className="card">
          <p className="section-title">
            Loaded documents{disk && <span className="disk"> · {disk.files} files, {disk.human} on disk</span>}
          </p>
          <div className="tablewrap">
            <table className="lines docs">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Kind</th>
                  <th className="num">Pages</th>
                  <th>In force</th>
                  <th>What came out</th>
                  <th className="num">Read</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id} className={d.effectiveTo ? "retired" : ""}>
                    <td>
                      <span className="doctitle">
                        {d.sourceFile ? (
                          <a href={`/api/doc/${encodeURIComponent(d.sourceFile)}`} target="_blank" rel="noopener noreferrer">{d.title}</a>
                        ) : d.title}
                      </span>
                      <span className="docmeta">
                        {d.issuer}
                        {d.meanOcrConfidence !== null && <> · OCR {(d.meanOcrConfidence * 100).toFixed(0)}%</>}
                        {d.addedBy && <> · added by {d.addedBy}</>}
                      </span>
                      {d.ingestError && <span className="docmeta err">{d.ingestError}</span>}
                      {d.supersedes && <span className="docmeta">replaces {d.supersedes.title}</span>}
                    </td>
                    <td>{DOC_TYPE_LABEL[d.docType] ?? d.docType}</td>
                    <td className="num">{d.pageCount ?? "—"}</td>
                    <td>
                      {fmtDate(d.effectiveFrom)}
                      {d.effectiveTo && <span className="docmeta">retired {fmtDate(d.effectiveTo)}</span>}
                    </td>
                    <td>
                      <span className="counts">
                        {d.counts.obligations > 0 && <em>{d.counts.obligations} rates</em>}
                        {d.counts.conditions > 0 && <em>{d.counts.conditions} conditions</em>}
                        {d.counts.amendments > 0 && <em>{d.counts.amendments} amendments</em>}
                        {d.counts.chunks > 0 && <em>{d.counts.chunks} searchable</em>}
                        {d.counts.pendingReview > 0 && (
                          <em className="pending"><Link href={`/review?document=${d.id}`}>{d.counts.pendingReview} to review</Link></em>
                        )}
                      </span>
                    </td>
                    {/*
                      A parser that found 0 of 4,000 candidate rows is broken. A
                      parser that found 0 of 0 was handed a document with nothing
                      of its kind in it. Printing "0%" for both, next to a note
                      saying the tariff reads at 99%, turns the second into an
                      accusation — so a coverage figure is only shown when there
                      was something to cover.
                    */}
                    <td className="num">
                      {!d.coverage ? (
                        "—"
                      ) : d.coverage.linesSeen > 0 ? (
                        <span title={d.coverage.notes ?? undefined}>
                          {d.coverage.coveragePct.toFixed(0)}%
                          <span className="docmeta">{d.coverage.rowsMatched}/{d.coverage.linesSeen}</span>
                        </span>
                      ) : (
                        <span title={d.coverage.notes ?? undefined}>
                          n/a
                          <span className="docmeta">nothing to read</span>
                        </span>
                      )}
                    </td>
                    <td className="rowactions">
                      <button
                        type="button"
                        className="linkbtn"
                        disabled={busyId === d.id || working}
                        onClick={() => reread(d)}
                        title="Read this PDF again with the current toolchain. The document, its dates and any approved rules are untouched — only the searchable text and pending suggestions are replaced."
                      >
                        Read again
                      </button>
                      <button
                        type="button"
                        className="linkbtn danger"
                        disabled={busyId === d.id}
                        onClick={() => askRemove(d)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {docs.length === 0 && (
                  <tr><td colSpan={7} className="empty">Nothing loaded yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="asat">
            Coverage is rows read against candidate rows seen. The bundled tariff reads at about 99% —
            a much lower figure on a new document means it is worth opening the original to see what was missed.
            <em>n/a</em> means the document held nothing of the kind that parser looks for, which is the
            normal result for a memo or a circular and is not a failure.
          </div>
        </div>
      </div>
    </div>
  );
}
