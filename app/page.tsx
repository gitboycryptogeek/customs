"use client";

import { useState } from "react";
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

type Mode = "words" | "form";

/** A legal reference — a link that opens the source PDF at the exact page when we know it. */
function Ref({ legalRef, sourceFile, page }: { legalRef: string; sourceFile: string | null; page: number | null }) {
  if (sourceFile && page) {
    return (
      <a className="ref" href={`/docs/${sourceFile}#page=${page}`} target="_blank" rel="noopener noreferrer">
        {legalRef}
        <span className="pg">↗ p.{page}</span>
      </a>
    );
  }
  return <span className="legal">{legalRef}</span>;
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

  function reset() {
    setError(null);
    setResult(null);
    setHits(null);
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
        <p>Ask in plain English or fill in the form. Every figure cites its legal source and page — uncertain values are flagged, never guessed.</p>
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
        </div>
      )}
    </div>
  );
}
