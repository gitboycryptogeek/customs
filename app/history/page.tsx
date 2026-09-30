"use client";

// Previous requests.
//
// Two kinds in one list: assessments the engine produced, and AI calls made over
// them. A row's whole job is to get you back to the thing — clicking an
// assessment re-runs it on the lookup page rather than showing a stored copy,
// because a stored total could have been drawn from a source that has since been
// superseded, and showing yesterday's figure as today's is the failure mode this
// codebase is most careful about.

import { useEffect, useState } from "react";
import Link from "next/link";

interface LookupRow {
  kind: "lookup";
  id: string;
  createdAt: string;
  itemQuery: string;
  hsCode: string | null;
  description: string | null;
  resolvedVia: string | null;
  customsValue: number | null;
  importerType: string;
  total: number | null;
  totalBlocked: boolean;
  lineCount: number;
  flagCount: number;
  requestedBy: string | null;
}

interface AiRow {
  kind: "ai";
  id: string;
  createdAt: string;
  mode: string;
  itemQuery: string;
  hsCode: string | null;
  customsValue: number | null;
  importerType: string;
  model: string;
  verified: boolean;
  proposalsCreated: number;
  inputTokens: number | null;
  outputTokens: number | null;
  requestedBy: string | null;
}

type Row = LookupRow | AiRow;

const KES = new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 });

function when(iso: string): string {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleString();
}

const MODE_LABEL: Record<string, string> = {
  brief: "AI briefing",
  audit: "AI audit",
  chat: "AI conversation",
};

export default function History() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "lookup" | "ai">("all");

  useEffect(() => {
    fetch("/api/history")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setRows(d.items);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const shown = (rows ?? []).filter((r) => filter === "all" || r.kind === filter);

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>History</h1>
        <p>
          Every assessment and every AI call, newest first. Opening an assessment re-runs it against
          the rules in force now — figures are never served from this list.
        </p>
      </header>

      <div className="card">
        <div className="tabs">
          {(
            [
              ["all", "Everything"],
              ["lookup", "Assessments"],
              ["ai", "AI calls"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`tab ${filter === k ? "active" : ""}`}
              onClick={() => setFilter(k)}
            >
              {label}
            </button>
          ))}
        </div>

        {error && <div className="error">{error}</div>}
        {rows === null && !error ? <p className="hint">Loading…</p> : null}

        {rows !== null && shown.length === 0 ? (
          <p className="hint">
            Nothing here yet. Run an assessment on the <Link href="/">Lookup</Link> page and it will
            appear.
          </p>
        ) : null}

        <div className="histlist">
          {shown.map((r) => (
            <div key={`${r.kind}-${r.id}`} className="histrow">
              <div className="histmain">
                <div className="histtop">
                  <span className={`histkind ${r.kind}`}>
                    {r.kind === "lookup" ? "Assessment" : MODE_LABEL[r.mode] ?? r.mode}
                  </span>
                  <span className="histwhen">{when(r.createdAt)}</span>
                  {r.requestedBy ? <span className="histwho">{r.requestedBy}</span> : null}
                </div>

                <div className="histq">{r.itemQuery || <em>(no item)</em>}</div>

                <div className="histmeta">
                  {r.hsCode ? <code>{r.hsCode}</code> : null}
                  {r.customsValue ? <span>KES {KES.format(r.customsValue)}</span> : null}
                  <span>{r.importerType}</span>

                  {r.kind === "lookup" ? (
                    <>
                      {r.totalBlocked ? (
                        <span className="histflag">no total — a line needs review</span>
                      ) : r.total !== null ? (
                        <span className="histtotal">KES {KES.format(r.total)}</span>
                      ) : null}
                      {r.flagCount > 0 ? <span className="histflag">{r.flagCount} flagged</span> : null}
                      {r.resolvedVia ? <span className="histvia">via {r.resolvedVia}</span> : null}
                    </>
                  ) : (
                    <>
                      {r.verified ? (
                        <span className="histok">verified</span>
                      ) : (
                        <span className="histflag">unverified</span>
                      )}
                      {r.proposalsCreated > 0 ? (
                        <span className="histvia">
                          {r.proposalsCreated} proposal{r.proposalsCreated === 1 ? "" : "s"} →{" "}
                          <Link href="/review">review</Link>
                        </span>
                      ) : null}
                      {r.inputTokens !== null && r.outputTokens !== null ? (
                        <span className="histvia">
                          {r.inputTokens.toLocaleString()} in / {r.outputTokens.toLocaleString()} out
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
              </div>

              <div className="histactions">
                {/* Re-runs rather than replays. The lookup page reads these and
                    assesses afresh, so a superseded source shows today's answer. */}
                <Link
                  className="go secondary"
                  href={`/?q=${encodeURIComponent(r.itemQuery)}${
                    r.customsValue ? `&value=${r.customsValue}` : ""
                  }&importer=${encodeURIComponent(r.importerType)}`}
                >
                  Run again
                </Link>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
