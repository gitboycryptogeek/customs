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
interface ApiResult {
  interpreted?: Interpreted;
  resolution: Resolution | null;
  assessment: Assessment | null;
  needsValue?: boolean;
  error?: string;
}

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
  const [query, setQuery] = useState("importing a laptop worth 150,000 for my company");
  const [value, setValue] = useState("");
  const [importer, setImporter] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/assess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, customsValue: value === "" ? null : Number(value), importerType: importer || undefined }),
      });
      const data: ApiResult = await res.json();
      if (!res.ok) setError(data.error || "Request failed");
      else setResult(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const a = result?.assessment;
  const it = result?.interpreted;

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>Customs Compliance Lookup</h1>
        <p>Ask in plain English. Every figure cites its legal source and page — uncertain values are flagged, never guessed.</p>
      </header>

      <div className="card">
        <form className="lookup" onSubmit={run} style={{ display: "block" }}>
          <label htmlFor="q">What are you importing?</label>
          <textarea
            id="q"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='e.g. "a laptop worth 150,000 for my company" — or just an HS code like 8471.30.00'
            rows={2}
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
            <button className="go" type="submit" disabled={loading}>
              {loading ? "Working…" : "Look up"}
            </button>
          </div>
        </form>
        <p className="hint">
          Try <code>a used electric motorcycle worth 200,000</code>, <code>2523.29.00</code>,{" "}
          <code>cement clinker valued at 100000 for a business</code>, or <code>rice worth 500000</code> (a blocked compound rate).
        </p>
      </div>

      {error && <div className="results"><div className="error">{error}</div></div>}

      {it && (
        <div className="results" style={{ marginBottom: result?.assessment || result?.needsValue || result?.resolution?.method === "miss" ? "-10px" : undefined }}>
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
            I understood the item, but I couldn&apos;t find a value in your sentence. Add an amount (e.g. &ldquo;…worth
            150,000&rdquo;) or type one in the <strong>Value override</strong> box.
          </div>
        </div>
      )}

      {result && !a && !result.needsValue && result.resolution?.method === "miss" && (
        <div className="results">
          <div className="miss">
            No HS code matched &ldquo;{it?.itemQuery}&rdquo;. This miss has been logged (the backlog that grows the
            shortcut list). Try different words, or enter an exact HS code like <code>8471.30.00</code>.
          </div>
        </div>
      )}

      {a && (
        <div className="results">
          <div className="resolved">
            <span className="code">{a.hsCode}</span>
            <span className="via">matched via {result!.resolution!.method}</span>
            {a.description && <span className="desc">{a.description}</span>}
          </div>

          {/* Plain-English summary first — the headline answer. */}
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

          {/* The detailed, citable breakdown. */}
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
