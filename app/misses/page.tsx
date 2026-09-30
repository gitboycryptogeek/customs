"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

// Searches that found nothing.
//
// Every row is a question somebody asked that the tool could not answer, and
// the fix for most of them is one line in the shortcut list. Ordered by how
// often each was asked, because that is what says which to do first.

interface Miss {
  term: string;
  query: string;
  count: number;
  lastSeen: string;
  resolvedTo: string | null;
}

export default function Misses() {
  const [misses, setMisses] = useState<Miss[]>([]);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [addedBy, setAddedBy] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/misses");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load the log.");
      setMisses(data.misses);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function addAlias(term: string) {
    const hsCode = (codes[term] ?? "").trim();
    setBusy(term);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/misses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ term, hsCode, addedBy: addedBy.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "That did not work.");
      setNotice(`“${term}” now resolves to ${data.alias.hsCode}.`);
      setCodes((prev) => ({ ...prev, [term]: "" }));
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const outstanding = misses.filter((m) => !m.resolvedTo);

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>Unmatched searches</h1>
        <p>
          Questions the tool could not answer. Adding a shortcut makes the same search work
          next time. <Link href="/documents">Documents</Link> · <Link href="/">Lookup</Link>
        </p>
      </header>

      {error && <div className="results"><div className="error">{error}</div></div>}

      <div className="card">
        <div>
          <label className="optlabel" htmlFor="by">Your name <span>(optional, recorded on each shortcut)</span></label>
          <input id="by" value={addedBy} onChange={(e) => setAddedBy(e.target.value)} placeholder="e.g. J. Otieno" />
        </div>
        <p className="hint">
          {outstanding.length} unmatched search{outstanding.length === 1 ? "" : "es"} waiting, most asked first.
          {notice && <> · <strong>{notice}</strong></>}
        </p>
      </div>

      <div className="results">
        <div className="card">
          {misses.length === 0 && (
            <p className="empty">Nothing logged. Every search so far has resolved to a tariff line.</p>
          )}

          {misses.map((m) => (
            <div key={m.term} className={`miss-row ${m.resolvedTo ? "done" : ""}`}>
              <div className="missq">
                <span className="qtext">{m.query}</span>
                <span className="qmeta">
                  asked {m.count}×· last {new Date(m.lastSeen).toISOString().slice(0, 10)}
                </span>
              </div>
              {m.resolvedTo ? (
                <span className="resolved-to">now → {m.resolvedTo}</span>
              ) : (
                <div className="missfix">
                  <input
                    value={codes[m.term] ?? ""}
                    onChange={(e) => setCodes((prev) => ({ ...prev, [m.term]: e.target.value }))}
                    placeholder="8471.30.00"
                    aria-label={`HS code for ${m.query}`}
                  />
                  <button
                    className="go"
                    type="button"
                    disabled={busy === m.term || !(codes[m.term] ?? "").trim()}
                    onClick={() => addAlias(m.term)}
                  >
                    {busy === m.term ? "Saving…" : "Add shortcut"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
