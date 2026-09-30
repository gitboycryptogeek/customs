/**
 * Check the two safety mechanisms around the AI briefing, without a network
 * call or an API key.
 *
 *   npx tsx scripts/verify-ai-report.ts [hsCode] [value] [importerType]
 *
 * 1. EGRESS — build the evidence pack for a known case and assert that what
 *    would leave the machine contains no identifier-shaped text, and no field
 *    outside the declared allowlist. A field added to the pack later fails this
 *    until somebody has decided it is safe to send.
 *
 * 2. VERIFIER — feed lib/ai/verify.ts a deliberately wrong briefing over that
 *    same pack and assert every invented figure is caught. A verifier that
 *    passes everything looks exactly like a verifier that works.
 *
 * The pack is printed in full, because "what does this actually send" should be
 * answerable by running one command.
 */
import { assess } from "../lib/assess";
import { buildEvidence, type EvidencePack } from "../lib/ai/evidence";
import { findIdentifiers, redactTerm } from "../lib/ai/redact";
import { verifyReport, verifyFindings } from "../lib/ai/verify";
import { TOOLS, runTool } from "../lib/ai/tools";
import type { Finding } from "../lib/ai/audit";
import { documentScope, UNRESTRICTED } from "../lib/ai/scope";
import { resolveHsCode } from "../lib/search";
import { prisma } from "../lib/db";

/** Every key the pack is allowed to carry, at every level. Checked structurally. */
const ALLOWED_KEYS = new Set([
  "item", "query", "hsCode", "description", "resolvedVia",
  "declared", "customsValue", "importerType",
  "charges", "label", "ratePct", "specificRate", "chargedOn", "amount", "legalRef",
  "sourceTitle", "page", "needsReview",
  "total", "totalBlocked",
  "flags", "severity", "message",
  "conditions", "type", "detail",
  "passages", "text",
  "documentsLoaded", "title", "issuer", "docType", "effectiveFrom", "effectiveTo",
  "rulesAsAt", "withheldDocuments",
]);

/** Item phrases that must not survive redaction intact. */
const REDACTION_CASES: { input: string; mustNotContain: string }[] = [
  { input: "laptop for Otieno Traders P051234567X", mustNotContain: "P051234567X" },
  { input: "cement, entry 2026-4471", mustNotContain: "2026-4471" },
  { input: "motorcycle contact 0712345678", mustNotContain: "0712345678" },
  { input: "rice invoice sent to clerk@example.com", mustNotContain: "clerk@example.com" },
  { input: "generator declaration no. C889231", mustNotContain: "C889231" },
];

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** First n in 11..99 whose rendered form satisfies `ok`. Used to build a figure this pack cannot contain. */
function pick(render: (n: number) => string, ok: (s: string) => boolean): string {
  for (let n = 11; n < 100; n++) {
    const s = render(n);
    if (ok(s)) return s;
  }
  throw new Error("could not construct a figure absent from the evidence pack");
}

/** Walk the pack and collect any key not on the allowlist. */
function unknownKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) unknownKeys(v, found);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (!ALLOWED_KEYS.has(k)) found.push(k);
      unknownKeys(v, found);
    }
  }
  return found;
}

async function main() {
  const hs = process.argv[2] ?? "8471.30.00";
  const value = Number(process.argv[3] ?? 150000);
  const importer = process.argv[4] ?? "private";

  console.log("\n1. Redaction — an item phrase must not carry an identifier out\n");
  for (const { input, mustNotContain } of REDACTION_CASES) {
    const out = redactTerm(input);
    check(`"${input}"`, !out.includes(mustNotContain), `-> "${out}"`);
  }
  check("an HS code survives redaction", redactTerm("8471.30.00").includes("8471.30.00"));

  console.log(`\n2. Egress — the evidence pack for ${hs} @ KES ${value.toLocaleString()} (${importer})\n`);
  const resolution = await resolveHsCode(hs);
  if (!resolution.hsCode) {
    console.error(`Could not resolve "${hs}" — is the tariff loaded? (npm run db:setup)`);
    process.exit(1);
  }
  const assessment = await assess(resolution.hsCode, value, importer);
  const pack: EvidencePack = await buildEvidence({
    itemQuery: hs,
    resolvedVia: resolution.method,
    customsValue: value,
    importerType: importer,
    assessment,
  });

  console.log(JSON.stringify(pack, null, 2));
  console.log("");

  const stray = unknownKeys(pack);
  check("every field is on the allowlist", stray.length === 0, stray.length ? `unexpected: ${[...new Set(stray)].join(", ")}` : "");
  check("the item phrase carries no identifier", findIdentifiers(pack.item.query).length === 0);
  check("no raw query field is present", !("raw" in (pack.item as object)));
  check("the pack cites at least one legal reference", pack.charges.every((c) => Boolean(c.legalRef)));

  console.log("\n3. Verifier — an invented figure must be caught\n");
  const realTotal = pack.total ?? "";

  // The invented figures are derived from this pack rather than hardcoded. A
  // fixed "35%" is only invented relative to a laptop: rice really is charged at
  // 35%, so hardcoding it would fail this script on a case where the verifier
  // was behaving correctly.
  const packJson = JSON.stringify(pack);
  const absentRate = pick((n) => `${n}.7%`, (s) => !packJson.includes(s.slice(0, -1)));
  const absentAmount = pick((n) => `${n},413`, (s) => !packJson.includes(s));
  const wrong = [
    "## What is chargeable",
    `Import Duty is ${absentRate} of the customs value, giving KES ${absentAmount}.`,
    "A further levy applies under heading 9999.99.99.",
  ].join("\n");
  const bad = verifyReport(wrong, pack);
  check(`flags the invented rate ${absentRate}`, bad.unsupported.includes(absentRate), `caught: ${bad.unsupported.join(", ") || "nothing"}`);
  check(`flags the invented amount KES ${absentAmount}`, bad.unsupported.some((u) => u.includes(absentAmount)));
  check("flags the invented HS code 9999.99.99", bad.unsupported.some((u) => u.includes("9999.99")));
  check("reports not-ok overall", !bad.ok);

  // The mirror case: figures taken straight from the pack must pass, or the
  // verifier would flag every honest briefing and be switched off within a week.
  const honest = [
    `The declared customs value is KES ${pack.declared.customsValue}.`,
    ...pack.charges.map((c) => `${c.label}: ${c.ratePct} of ${c.chargedOn} = KES ${c.amount}.`),
    realTotal ? `Total: KES ${realTotal}.` : "No total can be given.",
  ].join("\n");
  const good = verifyReport(honest, pack);
  check("passes a briefing built only from the pack", good.ok, good.unsupported.length ? `flagged: ${good.unsupported.join(", ")}` : `${good.checked} figures checked`);

  console.log("\n4. Audit tools — read-only, bounded, and every row identified\n");
  const calls: Awaited<ReturnType<typeof runTool>>[] = [];
  for (const tool of TOOLS) {
    const input: Record<string, unknown> =
      tool.name === "search_law"
        ? { query: "railway development levy" }
        : tool.name === "find_amendments"
          ? { query: "Cap. 469C" }
          : tool.name === "list_documents"
            ? {}
            : { hsCode: hs };
    const call = await runTool(tool.name, input);
    calls.push(call);
    check(`${tool.name} runs`, !call.error, call.error ?? `${call.rowCount} rows in ${call.ms}ms`);
  }
  check("no tool returned an unbounded result", calls.every((c) => c.rowCount <= 25));
  check("an unknown tool name is refused, not thrown", Boolean((await runTool("drop_tables", {})).error));

  // The engine takes ONE obligation row per levy type, so the tool must see at
  // least as much as the assessment did — otherwise it cannot catch what
  // longest-prefix-match discarded, which is the point of audit mode.
  const obligations = calls.find((c) => c.name === "get_obligations");
  const onRecord = (obligations?.result as { obligations?: unknown[] })?.obligations?.length ?? 0;
  check(
    "get_obligations sees at least what the assessment used",
    onRecord >= pack.charges.length,
    `${onRecord} rows on record vs ${pack.charges.length} charges shown`
  );

  console.log("\n5. Findings verifier — a citation must resolve to a row a query returned\n");
  const realId = calls.flatMap((c) => c.rowIds)[0];
  const findings: Finding[] = [
    { kind: "discrepancy", severity: "high", statement: "cites a real row", citations: [realId], officerAction: "check" },
    { kind: "addition", severity: "high", statement: "cites an invented row", citations: ["cm-not-a-real-id"], officerAction: "check" },
    { kind: "addition", severity: "low", statement: "cites nothing at all", citations: [], officerAction: "check" },
    { kind: "confirms", severity: "low", statement: "a clean confirmation needs no citation", citations: [], officerAction: "" },
  ];
  const fv = verifyFindings(findings, calls);
  check("keeps the finding citing a real row", fv.kept.some((f) => f.statement === "cites a real row"));
  check("drops the finding citing an invented row", fv.dropped.some((d) => d.statement === "cites an invented row"));
  check("drops an uncited non-confirming finding", fv.dropped.some((d) => d.statement === "cites nothing at all"));
  check("keeps an uncited 'confirms'", fv.kept.some((f) => f.kind === "confirms"));
  check("reports not-ok when anything was dropped", !fv.ok, `${fv.dropped.length} dropped`);
  check("drops everything when no query ever ran", verifyFindings(findings, []).kept.length === 0);
  console.log("\n6. Document scope — nothing added on this machine may leave\n");
  const added = await prisma.sourceVersion.findMany({
    where: { NOT: { storedPath: null } },
    select: { id: true, title: true },
  });
  const scope = await documentScope();

  if (added.length === 0) {
    console.log("  (skipped — no user-added documents in this database to withhold)");
  } else {
    check(
      `${added.length} added document${added.length === 1 ? " is" : "s are"} withheld by default`,
      scope.withheldCount === added.length && scope.allowed !== null,
      added.map((d) => d.title).join(", ")
    );
    check("no added document is in the allowed set", added.every((d) => !scope.allowed?.includes(d.id)));
    check("the model is told its view is partial", Boolean(scope.note), scope.note ? "note set" : "NO NOTE");

    // The real test: their text must not reach the pack or any tool result.
    const scopedPack = await buildEvidence({
      itemQuery: hs,
      resolvedVia: resolution.method,
      customsValue: value,
      importerType: importer,
      assessment,
      scope,
    });
    const packText = JSON.stringify(scopedPack);
    check(
      "no withheld document's title appears in the evidence pack",
      added.every((d) => !packText.includes(d.title)),
      `withheldDocuments: ${scopedPack.withheldDocuments}`
    );

    const scopedCalls = await Promise.all(
      TOOLS.map((t) =>
        runTool(
          t.name,
          t.name === "search_law"
            ? { query: "freight guidelines" }
            : t.name === "find_amendments"
              ? { query: "amended" }
              : t.name === "list_documents"
                ? {}
                : { hsCode: hs },
          scope
        )
      )
    );
    const toolText = JSON.stringify(scopedCalls);
    check(
      "no withheld document's title appears in any tool result",
      added.every((d) => !toolText.includes(d.title))
    );
    check(
      "no withheld document's id appears in any tool result",
      added.every((d) => !toolText.includes(d.id))
    );

    // And the mirror: with the setting on, it IS reachable — otherwise the
    // toggle would be doing nothing and the guarantee would be accidental.
    const openCalls = await runTool("list_documents", {}, UNRESTRICTED);
    check(
      "with the setting on, added documents become visible again",
      JSON.stringify(openCalls).includes(added[0].title)
    );
  }
  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
