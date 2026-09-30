"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Status {
  configured: boolean;
  ready: boolean;
  enabled: boolean;
  model: string;
  keySource: "env" | "file" | null;
  keyLast4: string | null;
  includeAddedDocuments: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * The switch on the only outbound network call this app makes.
 *
 * Everything else here runs offline against the bundled database and PDFs. This
 * page exists so turning that off is a deliberate act by a named person, and so
 * what does and does not leave the machine is written down where the person
 * deciding can read it.
 */
export default function Settings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [key, setKey] = useState("");
  const [by, setBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/ai/settings")
      .then((r) => r.json())
      .then(setStatus)
      .catch((e) => setError((e as Error).message));
  }, []);

  async function save(body: Record<string, unknown>, note: string) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch("/api/ai/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, updatedBy: by.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || "Could not save.");
      else {
        setStatus(data);
        setKey("");
        setSaved(note);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const envKey = status?.keySource === "env";

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>Settings</h1>
        <p>
          The AI briefing, and what it is allowed to send. <Link href="/">Lookup</Link>{" "}
          <Link href="/documents">Documents</Link>
        </p>
      </header>

      <div className="card">
        <p className="section-title">Before you switch this on</p>
        <p className="settings-lead">
          Everything else in this app runs on this machine — the tariff, the Acts, the search, every figure in an
          assessment. The briefing is the one feature that sends a request over the internet, to Anthropic&apos;s API.
          It is off until somebody here turns it on.
        </p>

        <div className="egress">
          <div className="egress-col">
            <p className="egress-head yes">What is sent</p>
            <ul>
              <li>The HS code and its tariff description</li>
              <li>The rates, amounts, legal references and page numbers already shown in the assessment</li>
              <li>The declared customs value and the importer type</li>
              <li>Passages from the four documents that ship with the app — the CET and the Acts, which are published</li>
            </ul>
          </div>
          <div className="egress-col">
            <p className="egress-head no">What is never sent</p>
            <ul>
              <li>The sentence an officer typed — it is reduced to an item, a value and an importer type first</li>
              <li>Trader names, KRA PINs, entry or declaration numbers</li>
              <li>Any file</li>
              <li>Documents added on this machine — unless you switch that on below</li>
              <li>Anything not in the assessment on screen</li>
            </ul>
          </div>
        </div>

        <p className="settings-lead">
          The briefing model never decides a rate. It restates the assessment the rules engine already produced, and
          every figure in what it writes is checked back against that assessment before you see it. Each briefing is
          recorded — who asked, what was sent, what came back.
        </p>
      </div>

      <div className="card">
        <p className="section-title">API key</p>

        {status === null ? (
          <p className="settings-lead">Loading…</p>
        ) : envKey ? (
          <p className="settings-lead">
            A key is being supplied by the <code>ANTHROPIC_API_KEY</code> environment variable (ending{" "}
            <code>{status.keyLast4}</code>). That overrides anything saved here, and cannot be changed from this page.
          </p>
        ) : (
          <>
            <label htmlFor="k">Anthropic API key</label>
            <input
              id="k"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={status.configured ? `saved — ending ${status.keyLast4}` : "sk-ant-…"}
              autoComplete="off"
            />
            <p className="hint">
              Stored in a file in your own application-data folder, next to your database — the same folder the app
              already keeps your added documents in, and one only this Windows/macOS account can open. The key is
              never shown again after saving, and never sent anywhere except to Anthropic.
            </p>

            <label htmlFor="sb" style={{ marginTop: 14 }}>
              Your name
            </label>
            <input id="sb" value={by} onChange={(e) => setBy(e.target.value)} placeholder="recorded against this change" />

            <div className="actions">
              <button className="go" type="button" disabled={busy || !key.trim()} onClick={() => save({ apiKey: key.trim(), enabled: true }, "Key saved and the briefing switched on.")}>
                {busy ? "Saving…" : status.configured ? "Replace key" : "Save key"}
              </button>
              {status.configured && (
                <button className="go secondary" type="button" disabled={busy} onClick={() => save({ apiKey: null }, "Key removed. The briefing is off.")}>
                  Remove key
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {status?.configured && (
        <div className="card">
          <p className="section-title">Documents the AI may read</p>
          <div className="toggle-row">
            <div>
              <p className="settings-lead" style={{ margin: 0 }}>
                {status.includeAddedDocuments
                  ? "Everything, including documents added on this machine."
                  : "Only the four published documents that ship with the app."}
              </p>
              <p className="hint" style={{ marginTop: 4 }}>
                The four bundled documents are published law. Anything added through <b>Documents</b> may not be —
                an internal circular or a draft memo would be sent to Anthropic like anything else. With this off,
                added documents are withheld and the AI is <em>told</em> they exist, so it reports that it could not
                check them rather than giving a confident all-clear over material it never saw.
              </p>
            </div>
            <button
              className={`go ${status.includeAddedDocuments ? "secondary" : ""}`}
              type="button"
              disabled={busy}
              onClick={() =>
                save(
                  { includeAddedDocuments: !status.includeAddedDocuments },
                  status.includeAddedDocuments
                    ? "Added documents are now withheld from the AI."
                    : "The AI can now read documents added on this machine."
                )
              }
            >
              {status.includeAddedDocuments ? "Withhold added documents" : "Include added documents"}
            </button>
          </div>
        </div>
      )}

      {status?.configured && (
        <div className="card">
          <p className="section-title">AI briefing</p>
          <div className="toggle-row">
            <div>
              <p className="settings-lead" style={{ margin: 0 }}>
                {status.enabled
                  ? "On — officers can draft a briefing from an assessment."
                  : "Off — no request will leave this machine."}
              </p>
              <p className="hint" style={{ marginTop: 4 }}>
                Model <code>{status.model}</code>
                {status.updatedBy && <> · last changed by {status.updatedBy}</>}
                {status.updatedAt && <> on {new Date(status.updatedAt).toISOString().slice(0, 10)}</>}
              </p>
            </div>
            {!envKey && (
              <button
                className={`go ${status.enabled ? "secondary" : ""}`}
                type="button"
                disabled={busy}
                onClick={() => save({ enabled: !status.enabled }, status.enabled ? "Briefing switched off." : "Briefing switched on.")}
              >
                {status.enabled ? "Switch off" : "Switch on"}
              </button>
            )}
          </div>
        </div>
      )}

      {saved && <div className="results"><div className="verify-ok">{saved}</div></div>}
      {error && <div className="results"><div className="error">{error}</div></div>}
    </div>
  );
}
