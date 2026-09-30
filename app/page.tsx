"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { levyLabel, basisLabel, ratePct, money } from "@/lib/labels";

interface Line {
  type: string;
  rate: number | null;
  specificRate?: string | null;
  basis: string;
  amount: number | null;
  legalRef: string;
  sourceFile: string | null;
  page: number | null;
  needsReview: boolean;
}
interface Condition {
  type: string;
  detail: string;
  legalRef: string;
  sourceFile: string | null;
  page: number | null;
}
interface Assessment {
  hsCode: string;
  description: string | null;
  plainSummary: string[];
  lines: Line[];
  total: number | null;
  conditions: Condition[];
  flags: { severity: "high" | "medium" | "low"; message: string }[];
  rulesAsAt: string;
}
interface Interpreted {
  itemQuery: string;
  customsValue: number | null;
  importerType: string;
  importerExplicit: boolean;
}
interface Resolution {
  method: string;
  hsCode: string | null;
  description: string | null;
}
interface AssessResponse {
  interpreted?: Interpreted;
  resolution: Resolution | null;
  assessment: Assessment | null;
  needsValue?: boolean;
  error?: string;
}
interface Hit {
  sourceTitle: string;
  sourceFile: string | null;
  page: number | null;
  hsCode: string | null;
  snippet: string;
  matched: number;
}

interface Verification {
  ok: boolean;
  unsupported: string[];
  checked: number;
}
interface Briefing {
  mode: "brief";
  reportId: string;
  model: string;
  report: string;
  evidence: unknown;
  verification: Verification;
}
interface Finding {
  kind: "confirms" | "discrepancy" | "addition" | "stale" | "unreviewed";
  severity: "high" | "medium" | "low";
  statement: string;
  citations: string[];
  officerAction: string;
  proposal?: { kind: string; hsPrefix: string; legalRef: string; reason: string };
}
interface Audit {
  mode: "audit";
  reportId: string;
  model: string;
  summary: string;
  findings: Finding[];
  dropped: { statement: string; reason: string }[];
  proposals: { created: number; skipped: { statement: string; reason: string }[] };
  stats: { turns: number; queries: number; rowsRead: number; truncated: boolean };
  queries: { name: string; input: Record<string, unknown>; rowCount: number; ms: number; error: string | null }[];
}
interface AiStatus {
  ready: boolean;
  model: string;
  includeAddedDocuments: boolean;
}

/** How a finding is introduced to an officer. The model's kind, in their words. */
const FINDING_LABEL: Record<string, string> = {
  confirms: "confirms the assessment",
  discrepancy: "competing record",
  addition: "not shown in the assessment",
  stale: "superseded source",
  unreviewed: "waiting on a person",
};

type Mode = "words" | "form";

/**
 * A legal reference — a link that opens the source PDF at the exact page.
 *
 * Routed through /api/doc rather than straight at /docs because documents a
 * user adds live outside the app bundle, and both kinds have to cite the same
 * way.
 */
function Ref({ legalRef, sourceFile, page }: { legalRef: string; sourceFile: string | null; page: number | null }) {
  if (sourceFile && page) {
    return (
      <a className="ref" href={`/api/doc/${encodeURIComponent(sourceFile)}#page=${page}`} target="_blank" rel="noopener noreferrer">
        {legalRef}
        <span className="pg">↗ p.{page}</span>
      </a>
    );
  }
  return <span className="legal">{legalRef}</span>;
}

/**
 * Render the briefing's markdown.
 *
 * The model is asked for five "## " headings, bullets and paragraphs, and that
 * is all this handles. A markdown library would be a dependency in the packaged
 * app for four line shapes — and anything the model emits outside them should
 * appear as the plain text it is, not be quietly reinterpreted.
 */
function BriefingBody({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];

  const flush = (key: string) => {
    if (!bullets.length) return;
    blocks.push(
      <ul key={key} className="brief-list">
        {bullets.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>
    );
    bullets = [];
  };

  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) {
      flush(`u${i}`);
      return;
    }
    if (line.startsWith("#")) {
      flush(`u${i}`);
      blocks.push(
        <h3 key={i} className="brief-head">
          {line.replace(/^#+\s*/, "")}
        </h3>
      );
      return;
    }
    if (/^[-*•]\s+/.test(line)) {
      bullets.push(line.replace(/^[-*•]\s+/, ""));
      return;
    }
    flush(`u${i}`);
    blocks.push(
      <p key={i} className="brief-p">
        {line}
      </p>
    );
  });
  flush("u-last");

  return <>{blocks}</>;
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("words");
  const [words, setWords] = useState("importing a laptop worth 150,000 for my company");
  const [formItem, setFormItem] = useState("laptop");
  const [value, setValue] = useState("");
  const [importer, setImporter] = useState("");
  const [loading, setLoading] = useState<null | "assess" | "search">(null);
  const [result, setResult] = useState<AssessResponse | null>(null);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searchedFor, setSearchedFor] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The AI briefing. Absent from the page entirely unless somebody has
  // configured a key and switched it on under Settings — this app is offline by
  // default and a button that always errors is worse than no button.
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [briefingBusy, setBriefingBusy] = useState<null | "brief" | "audit">(null);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  const [officer, setOfficer] = useState("");

  useEffect(() => {
    fetch("/api/ai/settings")
      .then((r) => r.json())
      .then((s: AiStatus) => setAi(s.ready ? s : null))
      .catch(() => setAi(null));
  }, []);

  function reset() {
    setError(null);
    setResult(null);
    setHits(null);
    // A briefing belongs to the assessment it was drafted over. Leaving the last
    // one on screen under a new result would attach its figures to the wrong item.
    setBriefing(null);
    setAudit(null);
    setBriefingError(null);
  }

  async function assess(text: string) {
    if (!text.trim()) return;
    reset();
    setLoading("assess");
    try {
      const res = await fetch("/api/assess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text, customsValue: value === "" ? null : Number(value), importerType: importer || undefined }),
      });
      const data: AssessResponse = await res.json();
      if (!res.ok) setError(data.error || "Request failed");
      else setResult(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(null);
    }
  }

  /**
   * Draft a briefing over the assessment on screen.
   *
   * Sends the same three fields the assessment itself was made from, and nothing
   * else. The server re-runs the engine and builds the evidence from the
   * database — a pack assembled here could be edited before it was sent, and the
   * pack is the only thing grounding what comes back.
   */
  async function runAi(want: "brief" | "audit") {
    const text = mode === "words" ? words : formItem;
    if (!text.trim()) return;
    setBriefingBusy(want);
    setBriefingError(null);
    setBriefing(null);
    setAudit(null);
    try {
      const res = await fetch("/api/ai/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: want,
          query: text,
          customsValue: value === "" ? null : Number(value),
          importerType: importer || undefined,
          requestedBy: officer.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) setBriefingError(data.error || "That could not be completed.");
      else if (data.mode === "audit") setAudit(data);
      else setBriefing(data);
    } catch (err) {
      setBriefingError((err as Error).message);
    } finally {
      setBriefingBusy(null);
    }
  }

  async function searchLaw(text: string) {
    if (!text.trim()) return;
    reset();
    setLoading("search");
    setSearchedFor(text);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text }),
      });
      const data: { hits?: Hit[]; error?: string } = await res.json();
      if (!res.ok) setError(data.error || "Search failed");
      else setHits(data.hits || []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(null);
    }
  }

  const a = result?.assessment;
  const it = result?.interpreted;
  const busy = loading !== null;

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>Customs Compliance Lookup</h1>
        <p>
          Ask in plain English or fill in the form. Every figure cites its legal source and page —
          uncertain values are flagged, never guessed. <Link href="/documents">Documents</Link>{" "}
          <Link href="/settings">Settings</Link>
        </p>
      </header>

      <div className="card">
        <div className="tabs">
          <button className={`tab ${mode === "words" ? "active" : ""}`} onClick={() => setMode("words")} type="button">
            Ask in words
          </button>
          <button className={`tab ${mode === "form" ? "active" : ""}`} onClick={() => setMode("form")} type="button">
            Use the form
          </button>
        </div>

        {mode === "words" ? (
          <form className="lookup" onSubmit={(e) => { e.preventDefault(); assess(words); }} style={{ display: "block" }}>
            <label htmlFor="q">Type a sentence, a word, an HS code — or paste a paragraph from a document</label>
            <textarea
              id="q"
              value={words}
              onChange={(e) => setWords(e.target.value)}
              placeholder='e.g. "a laptop worth 150,000 for my company" — or paste a paragraph and hit "Search the law"'
              rows={3}
            />
            <div className="overrides">
              <div>
                <label className="optlabel" htmlFor="v">Value override <span>(optional)</span></label>
                <input id="v" value={value} onChange={(e) => setValue(e.target.value)} inputMode="numeric" placeholder="from sentence" />
              </div>
              <div>
                <label className="optlabel" htmlFor="i">Importer override <span>(optional)</span></label>
                <select id="i" value={importer} onChange={(e) => setImporter(e.target.value)}>
                  <option value="">from sentence</option>
                  <option value="private">Private</option>
                  <option value="company">Company</option>
                  <option value="government">Government</option>
                  <option value="ngo">NGO</option>
                </select>
              </div>
            </div>
            <div className="actions">
              <button className="go" type="submit" disabled={busy}>
                {loading === "assess" ? "Working…" : "Assess duties & levies"}
              </button>
              <button className="go secondary" type="button" disabled={busy} onClick={() => searchLaw(words)}>
                {loading === "search" ? "Searching…" : "Search the law"}
              </button>
              <span className="aside">Assess = work out the charges · Search the law = find this text in the loaded documents</span>
            </div>
          </form>
        ) : (
          <form className="lookup" onSubmit={(e) => { e.preventDefault(); assess(formItem); }} style={{ display: "block" }}>
            <label htmlFor="fi">What is it? (description or HS code)</label>
            <input id="fi" value={formItem} onChange={(e) => setFormItem(e.target.value)} placeholder='e.g. "laptop" or 8471.30.00' />
            <div className="overrides">
              <div>
                <label className="optlabel" htmlFor="fv">Customs value (KES)</label>
                <input id="fv" value={value} onChange={(e) => setValue(e.target.value)} inputMode="numeric" placeholder="e.g. 150000" />
              </div>
              <div>
                <label className="optlabel" htmlFor="fim">Importer type</label>
                <select id="fim" value={importer} onChange={(e) => setImporter(e.target.value)}>
                  <option value="">Private (default)</option>
                  <option value="private">Private</option>
                  <option value="company">Company</option>
                  <option value="government">Government</option>
                  <option value="ngo">NGO</option>
                </select>
              </div>
              <button className="go" type="submit" disabled={busy}>
                {loading === "assess" ? "Working…" : "Assess"}
              </button>
            </div>
          </form>
        )}

        <p className="hint">
          Try <code>a used electric motorcycle worth 200,000</code>, <code>2523.29.00</code>,{" "}
          <code>rice worth 500000</code> (a blocked compound rate) — or paste a legal paragraph and{" "}
          <strong>Search the law</strong>.
        </p>
      </div>

      {error && <div className="results"><div className="error">{error}</div></div>}

      {/* ---------- Search-the-law results ---------- */}
      {hits && (
        <div className="results">
          <div className="card">
            <p className="section-title">Search the law</p>
            {hits.length === 0 ? (
              <p className="search-summary">
                No matching text found for &ldquo;{searchedFor.length > 80 ? searchedFor.slice(0, 80) + "…" : searchedFor}&rdquo; in the
                loaded documents. Only the CET tariff and the Fees &amp; Levies Act are loaded so far.
              </p>
            ) : (
              <>
                <p className="search-summary">{hits.length} matching passage{hits.length === 1 ? "" : "s"} in the loaded documents, best first:</p>
                {hits.map((h, i) => (
                  <div key={i} className="hit">
                    <div className="snippet">
                      {h.hsCode && <span className="hs">{h.hsCode}</span>}
                      {h.snippet}
                    </div>
                    <div className="hitref">
                      <span className="src">{h.sourceTitle}</span>{" — "}
                      <Ref legalRef={h.page ? `open page ${h.page}` : "no page link"} sourceFile={h.sourceFile} page={h.page} />
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* ---------- Interpreted banner (assess) ---------- */}
      {it && (
        <div className="results">
          <div className="understood">
            <span className="u-label">Understood:</span>
            <span className="chip">item <b>{it.itemQuery || "—"}</b></span>
            <span className="chip">value <b>{it.customsValue === null ? "not given" : `KES ${money(it.customsValue)}`}</b></span>
            <span className="chip">importer <b>{it.importerType}</b>{it.importerExplicit ? "" : " (assumed)"}</span>
          </div>
        </div>
      )}

      {result?.needsValue && (
        <div className="results">
          <div className="miss">
            I understood the item, but I couldn&apos;t find a value. Add an amount (e.g. &ldquo;…worth 150,000&rdquo;) or type one in
            the <strong>Value</strong> box.
          </div>
        </div>
      )}

      {result && !a && !result.needsValue && result.resolution?.method === "miss" && (
        <div className="results">
          <div className="miss">
            No HS code matched &ldquo;{it?.itemQuery}&rdquo;. This miss has been logged (the backlog that grows the shortcut list).
            Try different words, an exact HS code like <code>8471.30.00</code>, or use <strong>Search the law</strong> to find related text.
          </div>
        </div>
      )}

      {/* ---------- Assessment results ---------- */}
      {a && (
        <div className="results">
          <div className="resolved">
            <span className="code">{a.hsCode}</span>
            <span className="via">matched via {result!.resolution!.method}</span>
            {a.description && <span className="desc">{a.description}</span>}
          </div>

          <div className="card">
            <p className="section-title">In plain English</p>
            <ul className="summary">
              {a.plainSummary.map((s, i) => (
                <li key={i} className={i === 0 ? "headline" : i === a.plainSummary.length - 1 ? "grand" : ""}>
                  {s}
                </li>
              ))}
            </ul>
          </div>

          <div className="card">
            <p className="section-title">Breakdown — every figure cites its source</p>
            <table className="lines">
              <thead>
                <tr>
                  <th>Charge</th>
                  <th className="num">Rate</th>
                  <th>Charged on</th>
                  <th className="num">Amount (KES)</th>
                  <th>Legal reference (click to open the page)</th>
                </tr>
              </thead>
              <tbody>
                {a.lines.map((l, i) => (
                  <tr key={i}>
                    <td>
                      <span className="levy-type">{levyLabel(l.type)}</span>
                      {l.needsReview && <span className="review-tag">needs officer</span>}
                    </td>
                    <td className="num">{ratePct(l.rate)}</td>
                    <td className="charged">{basisLabel(l.basis)}</td>
                    <td className="num">{l.amount === null ? "—" : money(l.amount)}</td>
                    <td>
                      <Ref legalRef={l.legalRef} sourceFile={l.sourceFile} page={l.page} />
                    </td>
                  </tr>
                ))}
                <tr className="total">
                  <td>Total</td>
                  <td className="num"></td>
                  <td></td>
                  <td className="num">
                    {a.total === null ? <span className="blocked">needs review</span> : money(a.total)}
                  </td>
                  <td></td>
                </tr>
              </tbody>
            </table>
            <div className="asat">Rules as at {new Date(a.rulesAsAt).toISOString().slice(0, 10)}</div>
          </div>

          {a.flags.length > 0 && (
            <div className="card">
              <p className="section-title">Things to note</p>
              {a.flags.map((f, i) => (
                <div key={i} className={`flag ${f.severity}`}>
                  <span className="sev">{f.severity === "high" ? "important" : f.severity === "medium" ? "check" : "note"}</span>
                  <span>{f.message}</span>
                </div>
              ))}
            </div>
          )}

          {a.conditions.length > 0 && (
            <div className="card">
              <p className="section-title">Conditions to check</p>
              {a.conditions.map((c, i) => (
                <div key={i} className="condition">
                  <span className="ctype">{c.type}</span>
                  {c.detail}
                  <span className="legal">
                    <Ref legalRef={c.legalRef} sourceFile={c.sourceFile} page={c.page} />
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* ---------- AI briefing ---------- */}
          {ai && (
            <div className="card briefing">
              <p className="section-title">Officer&apos;s briefing</p>
              <p className="brief-lead">
                A short note drafted from the assessment above and the passages behind it. It restates what the rules
                engine found — it does not decide a rate, a total, or whether anything is compliant. Every figure it
                writes is checked back against the assessment before you see it.
              </p>

              <details className="egress-note">
                <summary>What will be sent to Anthropic</summary>
                <ul>
                  <li>
                    HS code <code>{a.hsCode}</code> and its tariff description
                  </li>
                  <li>The rates, amounts, legal references and pages in the table above</li>
                  <li>
                    The declared value (KES {money(it?.customsValue ?? null)}) and importer type ({it?.importerType})
                  </li>
                  <li>
                    Passages from{" "}
                    {ai.includeAddedDocuments
                      ? "every loaded document, including ones added on this machine"
                      : "the four published documents that ship with the app"}
                  </li>
                </ul>
                <p>
                  Not sent: the sentence you typed, any trader name, KRA PIN, entry or declaration number, or any file
                  {ai.includeAddedDocuments ? "" : ", or any document added on this machine"}. Change what it may read
                  under <Link href="/settings">Settings</Link>.
                </p>
              </details>

              <div className="brief-controls">
                <div>
                  <label className="optlabel" htmlFor="ob">
                    Your name <span>(recorded against this)</span>
                  </label>
                  <input id="ob" value={officer} onChange={(e) => setOfficer(e.target.value)} placeholder="e.g. J. Otieno" />
                </div>
                <button className="go" type="button" disabled={briefingBusy !== null} onClick={() => runAi("brief")}>
                  {briefingBusy === "brief" ? "Drafting…" : briefing ? "Draft again" : "Draft a briefing"}
                </button>
                <button className="go secondary" type="button" disabled={briefingBusy !== null} onClick={() => runAi("audit")}>
                  {briefingBusy === "audit" ? "Auditing…" : audit ? "Audit again" : "Audit against the database"}
                </button>
              </div>
              <p className="brief-modes">
                <b>Draft a briefing</b> writes up the assessment above. <b>Audit</b> goes further — it queries the
                database for what the assessment cannot show: a competing rate row, an unapplied Finance Act
                amendment, a pending proposal, a superseded source. It takes longer and costs more.
              </p>

              {briefingError && <div className="error" style={{ marginTop: 14 }}>{briefingError}</div>}

              {briefing && (
                <>
                  <div className={briefing.verification.ok ? "verify-ok" : "verify-bad"}>
                    {briefing.verification.ok ? (
                      <>
                        <b>Checked.</b> All {briefing.verification.checked} figures in this note appear in the
                        assessment above.
                      </>
                    ) : (
                      <>
                        <b>Not verified.</b> {briefing.verification.unsupported.length} figure
                        {briefing.verification.unsupported.length === 1 ? "" : "s"} in this note{" "}
                        {briefing.verification.unsupported.length === 1 ? "does" : "do"} not appear in the assessment
                        above —{" "}
                        {briefing.verification.unsupported.map((u, i) => (
                          <span key={u}>
                            {i > 0 && ", "}
                            <code>{u}</code>
                          </span>
                        ))}
                        . Treat the note as unreliable and work from the table.
                      </>
                    )}
                  </div>

                  <div className="brief-body">
                    <BriefingBody text={briefing.report} />
                  </div>

                  <div className="asat">
                    Drafted by {briefing.model} · not a decision, and not a legal document
                  </div>
                </>
              )}

              {audit && (
                <>
                  <div className="audit-summary">
                    <p className="audit-lead">{audit.summary}</p>
                    <p className="audit-stats">
                      {audit.stats.queries} database quer{audit.stats.queries === 1 ? "y" : "ies"} ·{" "}
                      {audit.stats.rowsRead} rows read · {audit.stats.turns} turn
                      {audit.stats.turns === 1 ? "" : "s"}
                      {audit.stats.truncated && <> · stopped at the limit — findings may be incomplete</>}
                    </p>
                  </div>

                  {audit.findings.length === 0 ? (
                    <div className="verify-ok">
                      <b>Nothing to raise.</b> The audit queried the database and found nothing the assessment does
                      not already show.
                    </div>
                  ) : (
                    <div className="findings">
                      {audit.findings.map((f, i) => (
                        <div key={i} className={`finding ${f.kind} ${f.severity}`}>
                          <div className="finding-head">
                            <span className="fkind">{FINDING_LABEL[f.kind]}</span>
                            <span className={`fsev ${f.severity}`}>{f.severity}</span>
                          </div>
                          <p className="fstatement">{f.statement}</p>
                          {f.officerAction && (
                            <p className="faction">
                              <b>Check:</b> {f.officerAction}
                            </p>
                          )}
                          {f.proposal && (
                            <p className="fproposal">
                              Proposed to the review queue as a {f.proposal.kind} on {f.proposal.hsPrefix} —{" "}
                              <Link href="/review">review it</Link>
                            </p>
                          )}
                          {f.citations.length > 0 && (
                            <p className="fcite">
                              rows read: {f.citations.map((c) => c.slice(-8)).join(", ")}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {audit.proposals.created > 0 && (
                    <div className="verify-ok">
                      <b>
                        {audit.proposals.created} proposal{audit.proposals.created === 1 ? "" : "s"} sent to the
                        review queue.
                      </b>{" "}
                      Nothing has changed in the rules — a person approves or rejects them on the{" "}
                      <Link href="/review">Review</Link> page, and only then does anything become a rule.
                    </div>
                  )}

                  {audit.dropped.length > 0 && (
                    <div className="verify-bad">
                      <b>
                        {audit.dropped.length} finding{audit.dropped.length === 1 ? " was" : "s were"} discarded
                      </b>{" "}
                      because {audit.dropped.length === 1 ? "it" : "they"} cited no row any query returned. Shown so
                      the failure is visible, not hidden:
                      <ul className="dropped">
                        {audit.dropped.map((d, i) => (
                          <li key={i}>
                            {d.statement} <span className="dreason">({d.reason})</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <details className="egress-note" style={{ marginTop: 14 }}>
                    <summary>What it actually queried ({audit.queries.length})</summary>
                    <table className="querylog">
                      <tbody>
                        {audit.queries.map((q, i) => (
                          <tr key={i}>
                            <td className="qname">{q.name}</td>
                            <td className="qargs">{JSON.stringify(q.input)}</td>
                            <td className="qrows">{q.error ? "error" : `${q.rowCount} rows`}</td>
                            <td className="qms">{q.ms}ms</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>

                  <div className="asat">
                    Audited by {audit.model} · read-only · findings only, nothing here changed a rule
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
