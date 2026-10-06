"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { levyLabel, ratePct } from "@/lib/labels";

// The review queue.
//
// Every row here is something a parser proposed. None of it affects an
// assessment until somebody approves it, and each row is shown beside the text
// it was read from with a link to that page of the original — because deciding
// whether a rate is right means looking at the source, not at a confidence
// score.

interface Row {
  id: string;
  kind: string;
  parserId: string;
  confidence: number;
  snippet: string;
  sourcePage: number | null;
  payload: Record<string, unknown>;
  document: { id: string; title: string; sourceFile: string | null; docType: string };
}

const KIND_LABEL: Record<string, string> = {
  obligation: "Rate",
  condition: "Condition",
  amendment: "Amendment",
};

function ReviewQueue() {
  const params = useSearchParams();
  const documentFilter = params.get("document");

  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewedBy, setReviewedBy] = useState("");
  const [kind, setKind] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams({ status: "pending", limit: "100" });
      if (documentFilter) qs.set("document", documentFilter);
      if (kind) qs.set("kind", kind);
      const res = await fetch(`/api/review?${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load the queue.");
      setRows(data.rows);
      setTotal(data.total);
      setSelected(new Set());
    } catch (err) {
      setError((err as Error).message);
    }
  }, [documentFilter, kind]);

  useEffect(() => { load(); }, [load]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function act(action: "approve" | "reject") {
    if (selected.size === 0) return;
    if (!reviewedBy.trim()) {
      setError("Enter your name first — approvals are recorded against a person.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids: [...selected], reviewedBy: reviewedBy.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "That did not work.");
      setNotice(
        action === "approve"
          ? `${data.approved} approved and now in force.${data.failed?.length ? ` ${data.failed.length} could not be applied.` : ""}`
          : `${data.rejected} rejected.`
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function describe(row: Row): string {
    const p = row.payload;
    if (row.kind === "obligation") {
      const rate = typeof p.rate === "number" ? ratePct(p.rate) : "no rate";
      const type = typeof p.type === "string" ? levyLabel(p.type) : "Charge";
      return `${type} ${rate} on ${p.hsPrefix || "all goods"}`;
    }
    if (row.kind === "condition") {
      return `${String(p.conditionType)} on ${p.hsPrefix || "all goods"}`;
    }
    return `${String(p.targetSection)} of the ${String(p.targetAct)} — ${String(p.operation)}`;
  }

  const allSelected = rows.length > 0 && selected.size === rows.length;

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>Review queue</h1>
        <p>
          Suggestions read out of documents. Nothing here affects an assessment until you approve it.{" "}
          <Link href="/documents">Back to documents</Link> · <Link href="/">Lookup</Link>
        </p>
      </header>

      {error && <div className="results"><div className="error">{error}</div></div>}

      <div className="card">
        <div className="reviewbar">
          <div>
            <label className="optlabel" htmlFor="who">Your name</label>
            <input id="who" value={reviewedBy} onChange={(e) => setReviewedBy(e.target.value)} placeholder="recorded against every approval" />
          </div>
          <div>
            <label className="optlabel" htmlFor="kind">Kind</label>
            <select id="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All</option>
              <option value="obligation">Rates</option>
              <option value="condition">Conditions</option>
              <option value="amendment">Amendments</option>
            </select>
          </div>
          <div className="reviewactions">
            <button className="go" type="button" disabled={busy || selected.size === 0} onClick={() => act("approve")}>
              {busy ? "Working…" : `Approve ${selected.size || ""}`}
            </button>
            <button className="go secondary" type="button" disabled={busy || selected.size === 0} onClick={() => act("reject")}>
              Reject {selected.size || ""}
            </button>
          </div>
        </div>
        <p className="hint">
          {total} waiting{documentFilter ? " in this document" : ""}, least certain first.
          {notice && <> · <strong>{notice}</strong></>}
        </p>
      </div>

      <div className="results">
        <div className="card">
          <p className="section-title">
            <label className="selectall">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
              />
              Select all shown
            </label>
          </p>

          {rows.length === 0 && <p className="empty">Nothing waiting. Everything read so far has been dealt with.</p>}

          {rows.map((row) => (
            <div key={row.id} className={`staged ${selected.has(row.id) ? "picked" : ""}`}>
              <label className="stagedpick">
                <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} />
              </label>
              <div className="stagedbody">
                <div className="stagedhead">
                  <span className="kind">{KIND_LABEL[row.kind] ?? row.kind}</span>
                  <span className="proposal">{describe(row)}</span>
                  {row.payload.needsReview === true && <span className="review-tag">uncertain rate</span>}
                </div>
                <div className="stagedsnippet">{row.snippet}</div>
                <div className="stagedref">
                  {row.document.sourceFile && row.sourcePage ? (
                    <a
                      className="ref"
                      href={`/api/doc/${encodeURIComponent(row.document.sourceFile)}#page=${row.sourcePage}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {row.document.title}
                      <span className="pg">↗ {/\.pdf$/i.test(row.document.sourceFile) ? "p." : "part "}{row.sourcePage}</span>
                    </a>
                  ) : (
                    <span className="legal">{row.document.title}</span>
                  )}
                  {row.parserId === "ai-audit" ? (
                    <>
                      <span className="parser">proposed by an AI audit</span>
                      <span className="ai-badge" title="A model suggested this. Open the legal reference and confirm it against the document before approving.">
                        AI — verify before approving
                      </span>
                    </>
                  ) : (
                    <span className="parser">read by {row.parserId}</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Review() {
  return (
    <Suspense fallback={<div className="wrap"><p>Loading…</p></div>}>
      <ReviewQueue />
    </Suspense>
  );
}
