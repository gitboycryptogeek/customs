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

There is exactly one deliberate exception, `lib/ingest/remove.ts`, and it is
narrow: a person removing a document they added by mistake, having been shown
the rules that go with it. Read the note at the top of that file before touching
it. Nothing else — no loader, no parser, no migration — may delete a version,
and "the user asked" is the only reason that counts.

**4. Anything uncertain is flagged, not guessed.**
`needs_review = true` and surface it. A blank field an officer fills in is
recoverable; a plausible wrong rate is not.

## Stack

TypeScript / Node, Prisma, Postgres 16 or portable SQLite, Next.js on
localhost:3000, Electron for the desktop build. `@anthropic-ai/sdk` for the
one optional feature that talks to the network — see the AI briefing below.

**The PDF toolchain is pure JS/WASM and lives in `lib/pdf/`.** `pdfjs-dist` for
text and geometry, `tesseract.js` for OCR, `@napi-rs/canvas` to rasterise. It
used to shell out to `pdftotext`/`pdffonts`/`pdftoppm`/`tesseract`; it no longer
does, because none of those exist on a stock Windows machine and users now add
documents from inside the packaged app. One implementation is shared by the CLI
loaders and the running app — two would mean two possible answers for one tariff
line.

Search on SQLite is an **FTS5** index (`prisma/app-migrations/002-chunks-fts.sql`);
on Postgres it is `tsvector`. Still no vector database.

Loaders are CLI scripts under `/scripts`, never API routes — the terminal loop is
much faster while tuning a parser. The in-app pipeline (`lib/ingest/`) reuses the
same parsers.

```
npx tsx scripts/load-cet.ts ./docs/cet-2022-june-2025.pdf
npx tsx scripts/assess.ts 8471.30.00 150000 private
npx tsx scripts/verify-parity.ts     # the toolchain still reproduces every duty row
```

## Document taxonomy — classify before parsing

`lib/ingest/classify.ts` does this, and records the counts behind its decision so
a user can see why a document was typed the way it was. Two things it gets right
that are worth preserving:

- **What a document calls itself outranks how it is shaped.** An EAC Routine
  Order is mostly rows of HS codes and rates and looks exactly like a tariff
  schedule by the numbers — but it carries time-bound measures that must not be
  auto-applied. The tariff marker is checked before the gazette marker, because
  the CET's own front matter cites the gazette it was published in.
- **Amending Acts are checked first**, since a Finance Act calls itself an Act.

**Type A — Schedule with a text layer** (EAC Common External Tariff)
Fixed-column table, 577 pages, clean fonts. `lib/pdf/layout.ts` reconstructs the
`-layout` character grid from pdf.js geometry; `lib/ingest/parsers/cet.ts` parses
it. 5,708 duty rows at 99.2% coverage. New schedules should go through
`lib/ingest/parsers/schedule-columns.ts` instead, which reads real column
geometry and needs no per-document tuning.

The layout grid has one rule that is load-bearing: **two runs on opposite sides
of a column gutter always get at least two spaces between them**, even when a
long description has already overrun that column. Every parser tells a column
boundary from a word space by counting spaces, so collapsing a gutter to one
space silently drops the row. That alone accounted for 40 missing CET rows.

Known artifacts in the CET, handle all three:
- U+2011 non-breaking hyphen inside descriptions — normalise to `-`
- words split across line breaks: `proce-ssing` → `processing`
- ~256 rows carry `SI` (Sensitive Item) where a rate should be. The real rate
  is in CET Annex I. Set `rate = null, needs_review = true`. Never coerce SI
  to zero.

**Type B — Scanned document, no text layer** (Finance Act 2026, "Print To PDF")
Detected by characters-per-page, sampled across the document, rather than by a
font table. Rasterised at 150dpi and OCR'd by tesseract.js, ~4s/page, ~88%
confidence. Store `ocr_confidence` per chunk.

OCR returns **word boxes, not just text**, and they are converted to the same
`PdfPage` shape a born-digital document produces — so the layout grid, gutter
detection and column reader work identically on a scan. This is not a nicety:
these Acts set cross-references in a narrow margin, and reading straight across
the page splices them into the middle of the operative sentence ("...is amended
in arene, subsection (1)"). `lib/pdf/margins.ts` removes that column. Before it
existed the amendment extractor found **zero** amendments in a document
containing fifty.

Raising DPI does not rescue a bad scan — 150, 200 and 300 all read the same
gazette rows and all miss the same ones. Do not reach for resolution first.

**Tesseract sometimes drops a region of a page instead of reading it badly**,
and a bordered table is what it usually drops. A KRA freight memo came back with
its column headings and not one of its nine figures; an EAC routine order lost a
duty-remission row the same way. There is no signal in the result — the page
reports 89% and reads as continuous prose — so `lib/pdf/recover.ts` looks for
the hole directly: a band BETWEEN two lines that were read, carrying ink that no
word box accounts for. That band is cut out with its neighbouring lines attached
and read again. Four things there are load-bearing:

- **Crop, do not use `SetRectangle`.** Pointing the engine at a region of the
  full page returns the same nothing. A crop is a different image and reads.
- **Sparse segmentation (PSM 11) for the second pass.** Auto segmentation is
  what refused the region the first time and refuses it again.
- **Include the lines above and below in the crop.** A bare strip of table cells
  reads `2,500` as `25,` + `500` and loses a row; with a line of ordinary text
  either side every cell comes back correct. Duplicates are dropped by box
  overlap.
- **Ignore rows that are more than 75% dark.** Those are printed rules, and
  without the ceiling every letterhead looks like a hole and buys a wasted pass.

Recovered words are held to a higher confidence bar (70) than the page itself,
because they enter the search index with nothing marking them as second-hand.
Real recoveries score 87-97; what the engine makes of a coat of arms scores 60s.
The gap scan itself costs 1-2ms a page and fires on roughly one page in six, so
a clean document pays nothing for this.

**Type C — Amending Act** (any Finance Act)
Critically: these contain **no rates**. They are diffs against other statutes:

> "Section 8 of the Income Tax Act is amended by deleting subsection (5A)."
> "Section 10 is amended by inserting... (n) sale of scrap metal; (o) winnings."

So a Finance Act NEVER loads directly into `obligations`. It loads into
`amendments` (target_act, target_section, operation, text, effective_from) as a
**human review queue**. A person decides which obligation rows change. ~40
amendments a year — an afternoon, not an engineering problem.

`lib/ingest/parsers/amending-act.ts` works head-then-body rather than matching one
sentence pattern: drafters write the same instruction several ways ("is amended
by inserting", "is amended in subsection (1), by deleting", "is amended — (a)"),
and a single regex catches only the first. Two things it must keep doing:

- **Bound the act-name capture** to letters and spaces. Once a page is reflowed
  into one line, an unbounded lazy `.+?` runs the length of the page hunting for
  the next "Act ... is amended", swallowing several genuine amendments inside one
  bogus match and reporting three paragraphs of statute as an act name.
- **Give each head the text up to the next head**, so one instruction can never
  absorb the following one.

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

StagedRow       // what a parser PROPOSED. assess() never reads this table.
  sourceVersionId, kind, payload (JSON), snippet, sourcePage,
  confidence, parserId, status, reviewedBy, producedId

ParseRun        // coverage of one parser over one document, stored not printed
  sourceVersionId, parserId, linesSeen, rowsMatched, coveragePct
```

**`StagedRow` is the safety mechanism for user-added documents.** A generic
parser reading an unfamiliar table writes there, a person approves it, and only
then does it become an `Obligation` carrying their name. Being wrong costs a
rejected suggestion rather than a wrong duty on somebody's declaration. Do not
add a path that writes parser output straight to `obligations`, and do not let
`assess()` read staging.

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

First try just adding it through **Documents** in the app. The generic parsers
handle most schedules and notices, and everything lands in review anyway. Write a
dedicated loader only when a document is both important and badly served by them.

When you do:

1. `npx tsx scripts/verify-classify.ts` → confirm it classifies A/B/C/D correctly,
   and fix the classifier rather than working around it
2. Write the parser in `lib/ingest/parsers/`, not in the loader, so the CLI and
   the app share it. `scripts/load-<name>.ts` stays a thin shell: hash-first,
   version-append, dry-run flag
3. Report parse coverage — rows matched vs. candidate lines seen. The CET parser
   hits 5,757 of 5,802. Know your gap and what is in it. `linesSeen = 0` is not
   0% coverage, it is no coverage figure at all — a memo with no tariff line in
   it was never going to yield one, and showing it as 0% next to the CET's 99%
   reads as an accusation. The UI prints `n/a`
4. Add fixtures before wiring it to the UI

## Adding documents from inside the app

`lib/ingest/` — store by content hash, queue, extract, classify, chunk, parse to
staging, review. Three constraints that are not obvious:

- **Ask for `effectiveFrom`, and leave the field blank.** No parser reads a
  commencement date reliably, and guessing it breaks "assessed against the rules
  in force at the time". Do not pre-fill it with today's date: the field is
  required, so a default is not a prompt but an answer, and a user who never
  looks at it has silently dated a memo from last September to today — which
  rule 3 then makes permanent.
- **Chunk by provision, not by page.** A chunk is what a search returns as its
  snippet, so page-level chunking turns a useful result into a wall of text.
  `lib/pdf/layout.ts` splits on enumerators (`(2)`, `(a)`, `7.`) as well as
  vertical gaps, because legislation is enumerated rather than spaced.
- **Approvals are recorded against a person.** An anonymous approval is not an
  audit trail.

### Word, Excel and CSV

`lib/office/` reads `.docx` (mammoth), `.xlsx` (exceljs) and `.csv` into the same
`ExtractedDocument` a PDF becomes; `lib/ingest/formats.ts` picks the reader by
extension and checks the file's bytes agree. Four things to keep:

- **Parts stand in for pages.** A part is up to 50 table rows or one prose
  section, given synthetic `PdfPage` geometry with a 4-character gutter between
  columns, so the column reader and every parser work unchanged. The HTML view
  (`lib/office/render.ts`, served by `/api/doc`) anchors each part as `page=N`,
  so the existing `#page=N` links land on it.
- **Cite rows, not parts.** `ExtractedDocument.locate` turns a page and line
  into `Sheet "Tariff", row 42`; the parsers use it for `legalRef` when present.
  When absent (every PDF) citations are exactly as before.
- **Read what the cell displays.** Percent-formatted numbers are multiplied out
  (`0.25` → `25%`); reading the raw value would make parseRate see a quarter of a
  percent. Formulas use the cached result; nothing is evaluated.
- **Never repeat a data row as a header.** The first row is repeated at the top
  of each part only if it names two or more columns and holds no HS code —
  otherwise each part would stage the same tariff line again.

A spreadsheet whose rows are mostly HS-code-and-rate is classified A at any size
(`classify(..., { tabular: true })`); the 20-row threshold exists to tell a PDF
schedule from prose quoting a few tariff lines, and a spreadsheet has no prose.

### Re-reading and removing

Two operations act on a document already in the library, and the line between
them is the line rule 3 draws.

**Re-read** (`PATCH /api/ingest`) reads the same file again with the current
toolchain — for when the extractor improved, not the document. The source
version is untouched: same id, same content hash, same dates. Only what was
derived from reading it is replaced, and rule 3 protects the document and the
rules drawn from it, not the search index built over it. Three things make it
safe to run on a document somebody has already worked through:

- Chunks carry an `origin`. `extract` is the extractor's and is replaced;
  `approval` is a description written when a person approved an obligation, and
  survives. Before that column the two were told apart by whether `sectionRef`
  looked like `p.7` or `8471`, which is not a distinction to bet an audit trail
  on.
- Only *pending* staged rows are cleared. Approved and rejected ones are the
  record of what somebody decided, and a re-read is not a new argument.
- `insertStaged` drops proposals matching anything already ruled on, keyed on
  what the row would become rather than on the text it was read from. Without
  it, every previously approved row comes back as a fresh suggestion and
  approving it twice writes two obligations for one tariff line.
- `ParseRun` rows are appended, never cleared — comparing the two readings is
  the point.

**Remove** (`DELETE /api/documents?id=…&confirm=1`) is the real thing: the
version, everything derived from it, and the stored file. Preview first (same
URL without `confirm`) and show what will go — the UI does. It refuses when
another version records this one as its predecessor, because that link is the
history rule 3 exists to keep, and it never unlinks a file out of the read-only
app bundle. A superseded tariff is *retired* with `supersede()`, not removed.

**The ingest queue is module state, and Next bundles each route file
separately.** `enqueue()` called from `/api/documents` and `status()` served
from `/api/ingest` are two different queues: the document is read and the
progress panel shows nothing, forever. Everything that touches the queue lives
in `app/api/ingest/route.ts`, including re-read, which otherwise belongs with
the other document operations.

Migrations run at server start from `prisma/app-migrations/` via `lib/migrate.ts`,
because a user's database is their own copy and the Prisma CLI is not bundled.
Additive only. Do NOT move this into Next's `instrumentation.ts` — that file is
compiled for the edge runtime too, `node:fs` cannot be bundled for edge, and it
breaks `npm run dev` outright.

## The AI briefing — what it may and may not do

`lib/ai/` adds one feature and one outbound network call. It exists because
reading a table of charges and turning it into *what matters here, what is
unresolved, what do I still have to check* is work an officer does in their head
on every item. It does not exist to answer a question.

Rule 1 still holds without an asterisk. **The model narrates; it never decides.**
`assess()` and `searchLaw()` run first and produce the entire factual basis; the
model is handed that as JSON and may only restate it in prose. Four things make
that a property of the code rather than a request in a prompt:

- **The route rebuilds the evidence itself.** `POST /api/ai/report` takes the
  same three scalars `/api/assess` takes and re-runs `interpret()` →
  `resolveHsCode()` → `assess()` server-side. It must never accept an evidence
  pack from the caller: the pack is the sole grounding *and* the thing the
  verifier checks against, so one supplied by the client defeats both at once.
- **Every figure is checked back.** `lib/ai/verify.ts` extracts every
  percentage, KES amount and HS code from the drafted prose and requires it to
  appear in the pack. The allowed set is built by scanning the serialised pack,
  not by listing fields — a field added later would otherwise be sent to the
  model but rejected by the verifier, and the failure would look like the model
  hallucinating. A failed check is **shown to the officer**, never swallowed and
  never used to hide the briefing.
- **Nothing that identifies a person leaves.** The officer's typed sentence is
  never sent. `interpret()` reduces it to an item phrase, a value and an importer
  type; `lib/ai/redact.ts` scrubs the phrase; `buildEvidence()` assembles the
  rest from deterministic output and from documents that are already published.
  Run `npm run verify:ai` to print the exact pack and assert it is clean.
- **Off by default.** No key, no feature — the button is not rendered, and the
  app behaves exactly as it did before this existed. `lib/ai/config.ts` reads its
  settings file on **every** call and never memoises: Next bundles each route
  file separately (see the ingest-queue note above), so a cached settings object
  would give `/api/ai/settings` and `/api/ai/report` two different views of the
  same file, and a key saved on one would be invisible to the other.

Every briefing is written to `ai_reports` — who asked, the pack exactly as sent,
the prose exactly as returned, and whether it verified. Append-only, like
everything else. A briefing that failed the check is the one most worth being
able to find again.

The scrubber runs over the item phrase only, not over the whole pack. Applying
those patterns to statutory text flags the Finance Act's own section numbering
and blocks a legitimate briefing; the item phrase is the one field in the pack
that originates with a person.

### Audit mode — the model querying the database

The briefing above restates a finished assessment. Audit mode does the opposite
and is the more valuable half: it goes looking for what the assessment *cannot*
show. The engine has four deliberate blind spots, and every one of them is a
thing an officer would want raised:

- longest-prefix-match takes ONE obligation row per levy type, so a competing
  row at the same prefix — or one at a broader prefix — never reaches the screen;
- a Finance Act's amendments sit unapplied by design, so a levy that has legally
  changed still shows its old rate;
- a parser's proposal waits in staging, invisible to `assess()`;
- a source version can be superseded without the figures drawn from it being
  revisited.

Finding those means querying the database, which means tools and a loop
(`lib/ai/tools.ts`, `lib/ai/audit.ts`). Four things keep it inside rule 1:

- **The tools are the boundary, not the prompt.** Six read-only, parameterised
  functions over Prisma. The model picks one and fills in typed arguments; it
  never composes SQL, nothing it can ask returns more than 25 rows, and nothing
  in that file or its imports writes. Execution is local — the model never
  connects to anything. The definitions are deliberately free of Anthropic and
  MCP types so the same functions can sit behind an MCP server later without the
  loop or the audit trail moving.
- **The tool log IS the evidence pack.** Where a briefing checks figures against
  a fixed pack, an audit checks *citations* against what queries actually
  returned. `verifyFindings()` drops any finding citing a row id no query
  produced, and the drops are shown on screen — a model inventing citations is
  precisely the failure this is built to expose, so hiding it would defeat the
  point. A `confirms` finding is the one exception: an absence has no row id.
- **Findings, never decisions.** A finding says what is on record and what to
  check. It never states a corrected rate as fact, never computes a total, never
  says whether anyone is compliant. An unapplied amendment is reported as
  unapplied — never as having changed a figure.
- **Bounded.** 8 turns, 20 tool calls, 8k tokens per turn. An agentic loop
  resends its history every turn, so an audit that will not stop is a bill.

**Proposals go to `staged_rows`, and only there.** A finding concrete enough to
act on is written to the existing review queue with `parserId = "ai-audit"` —
the same table, page and approval path a parser's proposal uses, because it is
the same kind of thing: a machine noticed something and a person decides. Three
constraints on that write (`lib/ai/propose.ts`):

- **An obligation proposal always carries `rate: null` and `needsReview: true`.**
  A model does not get to propose a figure. A person types the number or the row
  never becomes a rule.
- **The source document is resolved from the rows the finding cited**, never
  named by the model — an invented id would attach a proposal to the wrong Act,
  and rule 2 means that citation follows the row for life.
- **`confidence` is pinned low (0.2)** and means how well-evidenced the proposal
  is, never how legally correct. The review queue sorts least-confident first, so
  a model's suggestion lands where a person looks first, and the review page
  badges it so nobody mistakes it for a parse.

### Which documents the AI may read

`lib/ai/scope.ts`. The four documents that ship with the app are published law.
Anything a user adds through **Documents** is not necessarily anything of the
kind — an internal circular, a freight memo, a draft. Both live in the same
tables and both are searchable, so without a scope the briefing and the audit
read them out to an external service identically.

**Default: bundled documents only.** The discriminator is `storedPath` — null for
the bundled four, which sit inside the read-only app bundle, and set for anything
a user added, which has to go to the writable per-user folder. `addedBy` looks
like the natural field and is not: it is a free-text box people leave blank.

The part that matters is what happens to the excluded ones. They are **not
silently dropped** — the model is told how many documents it was not permitted to
read. A partial view it knows is partial yields "this assessment draws on a local
document I could not check; verify that line by hand", which is a useful finding.
A partial view it thinks is complete yields a confident all-clear over material
it never saw, which is the worst thing this feature could produce.

Switchable per install on the Settings page, because a user who adds the 2027
Finance Act does want the AI to see it. `npm run verify:ai` asserts both
directions: withheld titles and ids appear in neither the pack nor any tool
result, and turning the setting on makes them visible again — a guarantee that
holds only by accident is not one.

## Never do

- Auto-apply a Finance Act amendment to the rates table
- Let a parser write to `obligations` without a person approving it
- Send trader names, TINs, or entry numbers to any external service
- Overwrite a source version, or delete one anywhere but `lib/ingest/remove.ts`
- Return a total built on a `needs_review` row
- Let the briefing model produce a figure that is not already in the assessment
- Give the audit model a tool that writes, or one that takes SQL
- Let an audit finding change an assessment, a total, or a rate directly
- Accept a finding that cites a row no query returned
- Send a user-added document to the API without the scope setting being on
- Accept an evidence pack from the client, or send one built anywhere but the server
- Add a vector DB before full-text search has demonstrably failed
- Coerce an unparseable rate to 0
- Commit `prisma/customs.db`, or anything under `docs-store/`

The last one is not housekeeping. The repo is public, the database is where every
ingested document's text ends up, and `docs-store/` is where the PDFs themselves
land — so a document somebody drops into the **Documents** page to try it out
becomes a public file in the next commit. A KRA freight memo marked INTERNAL, the
one the OCR gap-recovery work above was built against, got as far as staged.

The database is a build output: `npm run db:build` from the four PDFs, or
`npm run db:fetch` for the one CI built. What the loaders are verified against is
`fixtures/baseline.json`, which by construction holds published law only —
`scripts/export-baseline.ts` scopes every query to the four shipped `sourceFile`
names, and a user's documents are stored under a content hash, so they cannot
match. Regenerate it only when a loader legitimately improves, and review the diff.
