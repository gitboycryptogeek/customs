/**
 * End-to-end check of adding a document from inside the app.
 *
 * This is the acceptance test for the whole ingest feature: a PDF goes in over
 * HTTP, is read, classified, chunked, indexed and staged; the text becomes
 * searchable and page-linked; a staged row is approved and only then reaches an
 * assessment; and re-adding the same file changes nothing.
 *
 * Point it at a running server:
 *   BASE=http://localhost:3000 npx tsx scripts/verify-ingest.ts <file.pdf>
 */
const BASE = process.env.BASE || "http://localhost:3000";

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

async function json(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.json();
  return { res, body };
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: tsx scripts/verify-ingest.ts <file.pdf>");
    process.exit(1);
  }
  const { readFile } = await import("node:fs/promises");
  const { basename } = await import("node:path");
  const bytes = await readFile(file);
  const name = basename(file);

  console.log(`Ingest check against ${BASE}\n${"=".repeat(60)}`);

  // --- 1. Upload -------------------------------------------------------------
  const form = new FormData();
  form.append("files", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), name);
  form.append("effectiveFrom", "2026-01-01");
  form.append("issuer", "Ingest self-test");
  form.append("addedBy", "verify-ingest");

  const up = await json("/api/ingest", { method: "POST", body: form });
  check(up.res.ok, "upload accepted", up.body.error ?? "");
  if (!up.res.ok) process.exit(1);
  check(up.body.queued === 1, `queued for reading (${up.body.queued})`);
  const id: string = up.body.accepted[0].sourceVersionId;

  // --- 2. Wait for it to be read --------------------------------------------
  const started = Date.now();
  let job: Record<string, unknown> | undefined;
  let lastLine = "";
  while (Date.now() - started < 15 * 60 * 1000) {
    const s = await json("/api/ingest");
    job = (s.body.active as Record<string, unknown>[]).find((j) => j.sourceVersionId === id);
    if (job && (job.stage === "ready" || job.stage === "failed")) break;
    if (job) process.stdout.write(`\r  reading… ${job.stage} ${job.page}/${job.totalPages}      `);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("");
  check(job?.stage === "ready", `document read (${job?.stage})`, String(job?.error ?? ""));
  console.log(`        classified as ${job?.docType}: ${job?.reason}`);

  // --- 3. Tier 1: searchable and page-linked, for every document -------------
  const docs = await json("/api/documents");
  const doc = (docs.body.documents as Record<string, unknown>[]).find((d) => d.id === id);
  const counts = doc?.counts as Record<string, number> | undefined;
  check((counts?.chunks ?? 0) > 0, `text chunked for search (${counts?.chunks} chunks)`);
  check(Boolean(doc?.sourceFile), "stored file recorded for page links");

  const sourceFile = String(doc?.sourceFile);
  const docRes = await fetch(`${BASE}/api/doc/${encodeURIComponent(sourceFile)}`);
  check(docRes.ok && docRes.headers.get("content-type") === "application/pdf", "stored PDF is served back");

  // Search for a phrase that must exist in any customs document we test with.
  const search = await json("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "levy customs value imported goods" }),
  });
  const hits = (search.body.hits ?? []) as { page: number | null; sourceFile: string | null }[];
  check(hits.length > 0, `text is findable (${hits.length} hits)`);
  check(hits.some((h) => h.page !== null), "hits carry a page number for deep linking");

  // --- 4. Tier 2: proposals are staged, not applied --------------------------
  const review = await json(`/api/review?document=${id}`);
  const pending = review.body.total as number;
  console.log(`        ${pending} suggestions staged for review`);

  const beforeCounts = counts;
  check(
    (beforeCounts?.obligations ?? 0) === 0,
    "nothing became a live rate before approval",
    `${beforeCounts?.obligations ?? 0} obligations exist`
  );

  // --- 5. Approval requires a name, then applies -----------------------------
  if (pending > 0) {
    const rows = review.body.rows as { id: string }[];
    const anon = await json("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve", ids: [rows[0].id] }),
    });
    check(anon.res.status === 400, "approval without a name is refused", anon.body.error ?? "");

    const ok = await json("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve", ids: [rows[0].id], reviewedBy: "verify-ingest" }),
    });
    check(ok.res.ok && ok.body.approved === 1, "approving one row applies it", JSON.stringify(ok.body.failed ?? []));

    const after = await json("/api/documents");
    const afterDoc = (after.body.documents as Record<string, unknown>[]).find((d) => d.id === id);
    const afterCounts = afterDoc?.counts as Record<string, number>;
    const grew =
      afterCounts.obligations > (beforeCounts?.obligations ?? 0) ||
      afterCounts.conditions > (beforeCounts?.conditions ?? 0) ||
      afterCounts.amendments > (beforeCounts?.amendments ?? 0);
    check(grew, "the approved row is now a real rule");
  }

  // --- 6. Re-adding the same file changes nothing ----------------------------
  const form2 = new FormData();
  form2.append("files", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), name);
  form2.append("effectiveFrom", "2026-01-01");
  const again = await json("/api/ingest", { method: "POST", body: form2 });
  check(again.body.queued === 0 && again.body.skipped === 1, "re-adding the same file is a no-op");

  console.log("=".repeat(60));
  console.log(failures === 0 ? "INGEST OK" : `INGEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
