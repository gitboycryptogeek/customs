# CLAUDE.md

Customs compliance lookup tool. An officer or admin asks "laptop, KES 150,000,
private company" and gets back every duty, levy and condition that applies —
each line citing the exact legal source and version it came from.

## Non-negotiable rules

**1. The rules engine is deterministic code. Never an LLM.**
Rates, thresholds, levies, exemption logic, and arithmetic live in Postgres and
TypeScript. Same inputs must always produce the same output, and that output
must survive a trader's legal challenge. If you are tempted to ask a model
"is this compliant?" — stop. Model output has no audit trail.

**2. Every number on screen carries a legal reference and a version date.**
`legal_ref` and `source_version_id` are NOT NULL on every obligation. A figure
that can't be traced to a document section is a bug, not a feature.

**3. Documents are append-only. Never UPDATE or DELETE a source version.**
A declaration filed in March 2025 is assessed against the rules in force in
March 2025. `effective_from` / `effective_to` on every rule row. Loaders that
overwrite are wrong.

**4. Anything uncertain is flagged, not guessed.**
`needs_review = true` and surface it. A blank field an officer fills in is
recoverable; a plausible wrong rate is not.

## Stack

TypeScript / Node, Prisma, Postgres 16 (local Docker in dev, Neon in prod),
Next.js on localhost:3000. `pdftotext` and `tesseract` from the system, called
via `execFileSync`. No vector database — Postgres `tsvector` handles search.

Loaders are CLI scripts under `/scripts`, never API routes. You will run them
dozens of times while tuning parsers; the terminal loop is much faster.

```
docker compose up -d
npx tsx scripts/load-cet.ts ./docs/cet-2022-june-2025.pdf
npx tsx scripts/assess.ts 8471.30.00 150000 private
```

## Document taxonomy — classify before parsing

Run `pdffonts` first. It determines everything downstream.

**Type A — Schedule with a text layer** (EAC Common External Tariff)
Fixed-column table, 577 pages, clean fonts. Extract with
`pdftotext -layout`, parse with a column regex. This is the bulk data source:
~5,900 duty rows in one pass. See `scripts/load-cet.ts`.

Known artifacts in the CET, handle all three:
- U+2011 non-breaking hyphen inside descriptions — normalise to `-`
- words split across line breaks: `proce-ssing` → `processing`
- ~256 rows carry `SI` (Sensitive Item) where a rate should be. The real rate
  is in CET Annex I. Set `rate = null, needs_review = true`. Never coerce SI
  to zero.

**Type B — Scanned document, no text layer** (Finance Act 2026, "Print To PDF")
`pdffonts` returns an empty table and `pdftotext` yields ~0 characters.
Rasterize with `pdftoppm -r 150` then `tesseract`. Body text OCRs cleanly;
marginal annotations garble ("Amepemient" for "Amendment") — ignore the
margins, they carry no substance. Store `ocr_confidence` per chunk.

**Type C — Amending Act** (any Finance Act)
Critically: these contain **no rates**. They are diffs against other statutes:

> "Section 8 of the Income Tax Act is amended by deleting subsection (5A)."
> "Section 10 is amended by inserting... (n) sale of scrap metal; (o) winnings."

So a Finance Act NEVER loads directly into `obligations`. It loads into
`amendments` (target_act, target_section, operation, text, effective_from) as a
**human review queue**. A person decides which obligation rows change. ~40
amendments a year — an afternoon, not an engineering problem.

Do not attempt to auto-apply amendments to the rules table. That is legal
interpretation, and getting it silently wrong is the worst failure mode this
system has.

**Type D — Circular / notice** (KEBS, KRA)
Usually Word or short PDF. Yields conditions, not rates: PVoC requirements,
restricted lists, exemption criteria. Loads into `conditions`.

## Data model

```prisma
SourceVersion   // immutable. contentHash (sha256) is the dedupe key.
  id, title, issuer, contentHash, effectiveFrom, effectiveTo,
  supersedesId, fetchedAt, docType  // A | B | C | D

Obligation      // one row per money obligation. LONG table, not wide.
  sourceVersionId, hsPrefix, type,   // duty | vat | idf | rdl | excise
  rate, basis,                       // customs_value | cif_plus_duty
  legalRef, needsReview, effectiveFrom, effectiveTo

Condition       // non-monetary requirements
  sourceVersionId, hsPrefix, conditionType,  // pvoc | exemption | restriction
  detail, appliesToImporterType, legalRef

Amendment       // Type C review queue
  sourceVersionId, targetAct, targetSection, operation, text,
  effectiveFrom, reviewedBy, appliedToObligationId

Chunk           // searchable text of every document
  sourceVersionId, sectionRef, text, tsv, ocrConfidence

Alias           // "macbook" -> 8471.30.00
  term, hsCode, confidence, addedBy
```

`hsPrefix` matters: most rules apply at chapter (`8471`) or heading
(`8471.30`) level, not the full 8 digits. **Match longest prefix wins.** One
row then covers hundreds of products.

## Search behaviour — what "smart" actually means here

Smart is coverage, not reasoning. Resolution order, always:

1. **Exact HS code** — if input matches `\d{4}\.\d{2}\.\d{2}`, done. In customs
   this is the real answer and it's unambiguous.
2. **Alias table** — `laptop`, `macbook`, `notebook pc` → `8471.30.00`.
3. **Full-text over descriptions** — `tsvector` + `ts_rank`, GIN index.
4. **Nothing found** — log the miss to `search_misses`. That log is the backlog
   for the alias table, and it is the single highest-value thing in this
   project. Review it weekly.

```sql
ALTER TABLE "chunks" ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;
CREATE INDEX chunks_tsv_idx ON "chunks" USING GIN(tsv);
```

Prisma can't express `tsvector` — declare it `Unsupported("tsvector")?` so
migrations stop dropping it, and query via `$queryRaw`. That's expected.

## Output contract

`assess(hsCode, customsValue, importerType, condition)` returns:

```ts
{
  hsCode, description,
  lines: [{ type, rate, basis, amount, legalRef, sourceVersionId }],
  total,
  conditions: [{ type, detail, legalRef }],
  flags: [{ severity, message }],   // SI rate, missing PVoC, stale source
  rulesAsAt: Date
}
```

Never return a total when any contributing line has `needsReview` or a null
rate. Return the partial breakdown plus a flag saying which line is missing.

## Testing

`fixtures/known-cases.json` — 20+ hand-verified cases: a laptop (0% duty), a
used car (25% + excise), cement, a zero-rated item, an SI item, one with an
exemption. Run after every change.

When a new Finance Act loads and three fixtures shift, that tells you instantly
whether the law changed or your parser broke. This is the whole regression
strategy.

## Adding a new document type

1. `pdffonts` → classify A/B/C/D
2. Write `scripts/load-<name>.ts`, hash-first, version-append, dry-run flag
3. Print parse coverage: rows matched vs. HS-code-like lines seen. The CET
   parser hits ~5,920 of ~6,176 — know your gap and what's in it
4. Add fixtures before wiring it to the UI

## Never do

- Auto-apply a Finance Act amendment to the rates table
- Send trader names, TINs, or entry numbers to any external service
- Overwrite a source version
- Return a total built on a `needs_review` row
- Add a vector DB before full-text search has demonstrably failed
- Coerce an unparseable rate to 0
