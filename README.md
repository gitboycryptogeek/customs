# Customs Compliance Lookup

Type what you're importing in plain English — **"a laptop worth 150,000 for my
company"** — and get back every duty, levy and condition that applies. Each
figure cites the exact legal source **and the page in the source PDF**, which you
can click to open.

> The rules engine is **deterministic code, never an AI model.** The same inputs
> always produce the same output, every figure carries a legal reference and a
> version date, sources are never overwritten, and anything uncertain is
> **flagged, not guessed.** The plain-English wording and the sentence-reading are
> just presentation — no model ever decides a rate or whether something is compliant.

---

## What it does

- **Two ways to ask.** Use the **form** (a description or HS code + value +
  importer type), or **ask in words** — a free-text box that takes a sentence, a
  single word, an HS code, or a whole pasted paragraph.
- **Ask in plain English.** "importing a used electric motorcycle worth 200,000"
  is read into `{ item, value, importer }` by simple pattern-matching (no AI) and
  looked up.
- **Search the law.** Paste a paragraph (e.g. copied from the Finance Act) and hit
  *Search the law* to find where that text appears across the loaded documents —
  each match links straight to its page in the PDF.
- **Add your own documents.** Drop in PDFs, Word (.docx), Excel (.xlsx) or CSV
  files from inside the app. They
  are read, classified, OCR'd if scanned, and made searchable — see
  [Adding documents](#adding-documents-in-the-app).
- **Answers in plain English.** Every result opens with a short summary anyone can
  read, e.g. *"Import Duty: 0% of the goods' value = KES 0. Estimated total taxes
  and levies: KES 6,750."*
- **Clickable, page-linked sources.** Each charge links to the exact page of the
  official PDF (e.g. the tariff for a laptop opens the CET at page 460).
- **Never guesses.** If a rate can't be pinned down (a "sensitive item", or a
  two-part "whichever is higher" rate), the line is flagged and **no final total**
  is shown — you get the partial breakdown plus a note explaining why.
- **An optional AI briefing.** Turn it on and an officer can have the assessment
  written up as a short note — what the item is, what is chargeable, what is
  unresolved, what still needs checking. Off by default; see below.

---

## The AI briefing (optional, off by default)

Everything above runs on the machine it is installed on. This is the one feature
that reaches the network, and it stays off until somebody opens **Settings** and
supplies an Anthropic API key.

It does not answer questions and it does not decide anything. The rules engine
runs first and produces every figure; the model is handed that result and asked
to write it up for an officer — *what this is, what is chargeable, what is
unresolved, conditions to satisfy, recommended next step*. Then:

- **Every figure it writes is checked back against the assessment** before you
  see it. Anything the model introduced on its own is listed on screen and the
  note is marked unverified. The check runs on every briefing and its result is
  always shown.
- **Only published documents are sent.** The four that ship with the app are
  published law. Anything you add through **Documents** is withheld by default —
  the AI is told those documents exist so it reports that it could not check
  them, rather than giving a clean bill of health over material it never saw.
  Switch it on under Settings if what you added is public.
- **Your typed sentence is never sent.** It is reduced to an item, a value and an
  importer type first, and that phrase is scrubbed of anything shaped like a KRA
  PIN, an entry or declaration number, a phone number or an email. What goes out
  is the assessment itself plus passages from the loaded documents, which are
  published. Each briefing shows you exactly what will be sent before you ask for
  it.
- **Every briefing is recorded** — who asked, what was sent, what came back, and
  whether it verified.

```bash
npm run verify:ai        # print the exact payload for a known case and check it
npm run verify:ai 1006.30.00 500000 company
```

### Two modes

**Draft a briefing** — one call. The model is handed the finished assessment and
writes it up. Roughly $0.02–0.05.

**Audit against the database** — the model queries the database itself, through
six read-only tools, looking for what the assessment *cannot* show:

- a competing duty row that longest-prefix-match discarded
- a Finance Act amendment sitting unapplied, so a levy on screen may be out of date
- a parser proposal waiting in the review queue that disagrees with a rate used
- a source document that has been superseded since the figure was drawn from it

Each finding must cite rows a query actually returned; ones that cite nothing
real are discarded and the discards are shown. The panel lists every query it
ran, with row counts and timings, so *what did it actually look at* is
answerable on screen. Roughly $0.15–0.40, and slower.

A finding concrete enough to act on is proposed into the **Review** queue you
already have — badged as AI-proposed, with any rate left blank for a person to
fill in. Nothing becomes a rule until somebody approves it, exactly as with a
parser's proposal.

Remove the key under Settings and both buttons disappear; the app is fully
offline again.

---

## Desktop app (double-click to run — no terminal)

The whole thing packages as a normal installable program with its own icon and
window. No Node, no Postgres, no `npm run dev` — the built app bundles the
server, the SQLite database, the source PDFs and the OCR engine, and runs fully
offline.

```bash
npm install          # once
npm run db:fetch     # once — the database is a build output, not in the repo
npm run dist:win     # -> release/Customs Compliance-Setup-0.4.1.exe
npm run dist:linux   # -> release/*.AppImage (+ .deb)
npm run dist:mac     # -> release/*.dmg  (must be built on a Mac)
```

### Getting it to users

Installers are published to **GitHub Releases** by
`.github/workflows/build-desktop.yml`. Push a version tag and the workflow builds
on real Windows/macOS/Linux runners, then publishes the installers **and the
`latest.yml` update feed** that `electron-updater` reads:

```bash
npm version minor        # bump package.json
git push --follow-tags
```

The **download page** lives in [`site/`](site/) and deploys to Heroku on its own.
It reads the GitHub Releases API, shows the current version, and hands each
visitor the right installer. Binaries are not stored there — a Heroku dyno has an
ephemeral filesystem and a 500MB slug limit, and each installer is 150–250MB.

### Updates

| Platform | Updates |
|---|---|
| Windows (NSIS) | Automatic, with differential downloads |
| Linux AppImage | Automatic |
| Linux `.deb` | Manual — the package manager owns that copy |
| macOS | **Manual.** Squirrel.Mac refuses to apply an unsigned update, and these builds are unsigned. The app checks the version and points at the download page. |

The app checks shortly after start and every six hours; *Help → Check for
updates* forces it. Builds are unsigned, so Windows shows a SmartScreen warning
on first run — the download page walks users through it.

---

## Running it locally

Two ways, and they cannot share `.next` — `next dev` and `next build` both own
that directory, so running one replaces the other's output.

```bash
npm install            # once
npm run db:fetch       # once — see "Where the database comes from" below

npm run dev            # the web app on http://localhost:3000 — fastest loop
npm run app:dev        # the actual desktop app in its own window
```

`npm run app:dev` rebuilds the bundle first, so it is always safe to switch
between the two. Plain `electron .` after `npm run dev` is not — the bundle has
been replaced, and the app now says so instead of hanging for thirty seconds.

If `localhost:3000` looks stale or dead, something else is already on that port:
Next quietly falls back to 3001/3002 and prints the real one in its startup
output. Check there.

## Quick start (no database to install)

Needs **no Postgres and no PDF tools** — SQLite is a file, and the source PDFs are
in the repo.

```bash
git clone https://github.com/gitboycryptogeek/customs.git
cd customs
cp .env.example .env         # .env.example already defaults to SQLite
npm install                  # also generates the database client
npm run db:fetch             # the prebuilt database, from the latest release
npm run dev                  # open http://localhost:3000
```

Everything above works on Windows exactly the same (PowerShell or Git Bash). Use
`copy .env.example .env` instead of `cp`.

### Where the database comes from

`prisma/customs.db` is a **build output and is not committed.** Two ways to get one:

```bash
npm run db:fetch     # download the one CI built — seconds
npm run db:build     # build it from public/docs/ — 5-10 min, 111 pages of OCR
```

`db:build` is the only option if you have changed a loader, since a released
database predates your change. It refuses to overwrite an existing database
unless you pass `--force`, because documents you added through the app live in
there and cannot be recovered from `docs-store/` without re-adding them.

It is a build output for a reason. A committed database made one file serve as
build input, test fixture and the dev app's live store all at once — so anything
ingested through the **Documents** page became a file staged for a public commit.
What the loaders are *verified* against is `fixtures/baseline.json`, which holds
rows read from the four published-law PDFs and nothing else.

---

## Adding documents in the app

Open **Documents** and drop PDFs in — a hundred at a time is fine. There is
nothing to install alongside: text extraction is `pdfjs-dist` and OCR is
`tesseract.js`, both pure JS/WASM, with the English language data bundled. It
never goes online to do this.

What happens to each document depends on what it turns out to be, and the split
is deliberate:

| Tier | Applies to | Automatic? |
|---|---|---|
| **Searchable and citable** — hashed, classified, OCR'd if scanned, chunked by provision, page-indexed | **every document** | yes |
| **Rate and condition extraction** — HS prefix, rate, basis | documents shaped like a schedule or notice | **proposed only** |
| **Legal interpretation** — which rule an amendment changes | nothing | never |

Tier 1 is the bulk of the value and works on anything. Tier 2 output goes to a
**review queue**, where each suggestion is shown beside the text it was read from
with a link to that page of the original. **Nothing reaches an assessment until a
person approves it**, and approvals are recorded against a name. `assess()` never
reads the staging table — that separation, not a confidence score, is what makes
it safe to run a generic parser over documents nobody has inspected.

Speed: a PDF with a text layer takes seconds. A scan is read a page at a time at
roughly two to four seconds a page, so a 300-page Act is 15–20 minutes. It runs
in the background with progress and can be cancelled.

### Word, Excel and CSV files

`.docx`, `.xlsx` and `.csv` go through exactly the same pipeline — classified,
searchable, and parsed into the same review queue. They are read from the file's
own structure (`lib/office/`), so a spreadsheet's columns are given rather than
guessed, and that makes a rate table in Excel the most reliable kind of schedule
to add.

- **Citations point at rows, not pages.** A rate read from a spreadsheet cites
  `Sheet "Tariff", row 42`; a Word table cites `table 1, row 3`; prose cites its
  section and paragraph numbers.
- **Clicking a citation opens the file as a page** in the browser, at the part
  cited, with source row numbers printed beside each row. The original file is a
  click away ("Download the original file").
- **What a cell shows is what is read.** A rate stored as `0.25` and formatted as
  a percentage reads as `25%`. Formulas are read by the value Excel last
  calculated; nothing is recalculated.
- **CSV** may be comma-, semicolon- or tab-separated, in UTF-8 or the Windows
  encoding Excel uses for plain "CSV".
- Older `.doc` and `.xls` files are refused with a message asking for them to be
  saved as `.docx` / `.xlsx`.

Documents you add are stored by content hash in a per-user folder that survives
updates, so re-adding the same file is a no-op.

---

## Switching the database (`DB_PROVIDER`)

The database engine is chosen by one line in `.env`:

```env
DB_PROVIDER="sqlite"                    # a single portable file, no server
DATABASE_URL="file:./customs.db"
```

To use **Postgres** instead (it enables Postgres `tsvector` full-text search):

```env
DB_PROVIDER="postgres"
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/customs"      # Docker / local
# DATABASE_URL="postgresql://USER:PASSWORD@HOST/customs?sslmode=require"   # Neon (cloud, no install)
```

```bash
npm run db:setup     # selects the right schema + creates the tables
npm run load:cet -- "public/docs/cet.pdf"
npm run load:levies -- "public/docs/misc-fees-and-levies.pdf"
npx tsx scripts/seed-aliases.ts
```

On SQLite, search uses an **FTS5** index created by `scripts/migrate.ts`. That
matters once a user starts adding documents: the previous implementation scored
every chunk in memory, which is fine at four documents and fatal at a hundred.

### Migrations inside the packaged app

A user's database is their own copy of the shipped one, so a release that adds a
column has to bring it forward in place — and the Prisma CLI isn't in the
bundle. Ordered SQL in `prisma/app-migrations/` is applied at server start by
`lib/migrate.ts`. Migrations are additive only.

---

## Loading documents from the command line

Only needed if you're rebuilding the shipped data. **No system tools are
required** — poppler and tesseract are no longer used.

| Document | Loader | Loads into | Status |
|---|---|---|---|
| EAC Common External Tariff 2022 (rev. Jun 2025) | `load-cet.ts` | `obligations` (duty) | 5,708 rows, 99.2% coverage, page-linked |
| Miscellaneous Fees & Levies Act (Cap. 469C) | `load-misc-levies.ts` | `obligations` (IDF 2.5%, RDL 2%) + `conditions` | loaded, page-linked |
| Finance Act 2026 (scanned) | `load-finance-act.ts` | `amendments` (review queue) | 29 amendments, OCR'd at ~88% |
| EAC Gazette Routine Order No.2 (scanned) | `load-routine-order.ts` | `conditions` (review) | loaded, OCR'd at ~88% |

The source PDFs live in `public/docs/` and are served through `/api/doc/<file>`,
which also serves anything a user adds.

---

## How the plain-English input is read (deterministic)

`lib/interpret.ts` pulls three things out of a sentence with plain pattern-matching:

- **Value** — a number, preferring one next to a currency word (`KES`, `shillings`,
  `/=`) or with a `k`/`m` suffix; small stray numbers (like "10 kg") are ignored.
- **Importer type** — keywords: *company/ltd/business* → company, *government/
  ministry/county* → government, *ngo/charity* → NGO, otherwise private.
- **Item** — whatever text is left after removing the value, the importer words and
  filler like "importing", "worth", "for my".

The item is then resolved to an HS code in a fixed order — **exact code → shortcut
list (aliases) → full-text search → logged miss** — and only then does the
deterministic engine compute the charges.

---

## Verifying it

```bash
npm test               # hand-verified regression cases (fixtures/known-cases.json)
npm run verify:parity  # the PDF toolchain reproduces every duty row in the baseline
npm run verify:classify # the four shipped documents are classified correctly
npm run verify:loaders -- /tmp/scratch.db   # full reload, compared against the baseline
npm run baseline:export # regenerate fixtures/baseline.json — review the diff
BASE=http://localhost:3000 npm run verify:ingest -- public/docs/misc-fees-and-levies.pdf
```

`verify:parity` is the gate that matters. The PDF toolchain moved off
poppler/tesseract onto pdf.js/tesseract.js so the packaged app can read documents
on a machine with nothing installed; that swap is only safe if it produces the
same rows, and this proves it against `fixtures/baseline.json` — **5,710
obligations, every HS prefix and rate identical**.

The baseline is the hand-verified ground truth, committed as JSON rather than as a
database so that it is diffable and so that it can only ever contain published
law. `npm run verify:loaders` proves it is reproducible: a clean load of the four
PDFs into a scratch database reproduces every gated row. Regenerate it with
`npm run baseline:export` only when a loader legitimately improves — that diff is
the claim that the change was intended.

---

## Handy commands

```bash
npm run dev            # web app on http://localhost:3000
npm run db:studio      # browse the data in Prisma Studio
npx tsx scripts/assess.ts "<sentence, term, or HS code>" [value] [importer]
```

---

## How it's built

TypeScript / Node, Prisma, Next.js, Electron. Two Prisma schema variants
(`prisma/schema.postgres.prisma`, `prisma/schema.sqlite.prisma`) are selected onto
`prisma/schema.prisma` by `scripts/select-schema.ts`.

| Area | Where |
|---|---|
| Deterministic engine | `lib/assess.ts` |
| Resolution (code → alias → full-text → miss) | `lib/search.ts` |
| Reading a sentence | `lib/interpret.ts` |
| PDF toolchain (extract, layout, columns, OCR, margins) | `lib/pdf/` |
| Ingest (classify, chunk, queue, parsers, review) | `lib/ingest/` |
| Desktop shell, updater, menu | `electron/` |
| Download page | `site/` |

### Key rules honoured (see `CLAUDE.md`)

- **Deterministic engine, never an LLM** for any rate, threshold or total.
- **Every figure cites `legalRef` + version + page.**
- **Sources are append-only.** Replacing a tariff closes the old version's
  effective window; nothing is deleted.
- **Uncertain values are flagged (`needsReview`), never coerced.**
- **Finance Act amendments are never auto-applied** — they load into a human
  review queue.

## Scope note on VAT / excise

Duty (CET), IDF and RDL (Cap. 469C) are loaded from their source PDFs. **VAT and
excise are intentionally absent** — their source Acts weren't provided, and we
don't invent a rate without a citable source. Add the Act through **Documents**,
or write a loader, to populate those levy types.
