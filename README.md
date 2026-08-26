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
- **Answers in plain English.** Every result opens with a short summary anyone can
  read, e.g. *"Import Duty: 0% of the goods' value = KES 0. Estimated total taxes
  and levies: KES 6,750."*
- **Clickable, page-linked sources.** Each charge links to the exact page of the
  official PDF (e.g. the tariff for a laptop opens the CET at page 460).
- **Never guesses.** If a rate can't be pinned down (a "sensitive item", or a
  two-part "whichever is higher" rate), the line is flagged and **no final total**
  is shown — you get the partial breakdown plus a note explaining why.

---

## Quick start (no database to install)

This is the easiest way and needs **no Postgres and no PDF tools** — the repo
ships a ready-built SQLite database and the source PDFs.

```bash
git clone https://github.com/gitboycryptogeek/customs.git
cd customs
cp .env.example .env         # .env.example already defaults to SQLite
npm install                  # also generates the database client
npm run dev                  # open http://localhost:3000
```

That's it. Try the examples on the page, or from the terminal:

```bash
npx tsx scripts/assess.ts "a laptop worth 150000 for my company"
npx tsx scripts/assess.ts 8471.30.00 150000 private
```

### Windows note

Everything above works on Windows exactly the same (PowerShell or Git Bash). Use
`copy .env.example .env` instead of `cp`. You do **not** need Postgres, Docker,
or `pdftotext` for the quick start — the shipped `prisma/customs.db` already
contains the loaded data.

---

## Switching the database (`DB_PROVIDER`)

The database engine is chosen by one line in `.env`:

```env
DB_PROVIDER="sqlite"                    # a single portable file, no server
DATABASE_URL="file:./customs.db"
```

To use **Postgres** instead (it enables Postgres `tsvector` full-text search),
put this in `.env` and run the setup once:

```env
DB_PROVIDER="postgres"
# pick one connection string:
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/customs"      # Docker / local
# DATABASE_URL="postgresql://USER:PASSWORD@HOST/customs?sslmode=require"   # Neon (cloud, no install)
```

```bash
npm run db:setup     # selects the right schema + creates the tables
# then load the data from the PDFs (needs pdftotext — see below):
npm run load:cet -- "public/docs/cet.pdf"
npm run load:levies -- "public/docs/misc-fees-and-levies.pdf"
npx tsx scripts/seed-aliases.ts
```

`npm run db:use sqlite` / `npm run db:use postgres` just switches the schema and
regenerates the client without touching data.

> A quick way to get Postgres with zero install is [Neon](https://neon.tech) —
> create a free database and paste its connection string as `DATABASE_URL`.

---

## Loading documents from the PDFs

Only needed if you're rebuilding the data (the quick start already has it). The
loaders shell out to `pdftotext` (from **poppler-utils**), and the two scanned
documents also need `tesseract`:

```bash
# Linux:   sudo apt install -y poppler-utils tesseract-ocr
# macOS:   brew install poppler tesseract
# Windows: install poppler for Windows, or just use the shipped SQLite DB.
```

| Document | Loader | Loads into | Status |
|---|---|---|---|
| EAC Common External Tariff 2022 (rev. Jun 2025) | `load-cet.ts` | `obligations` (duty) | ✅ 5,708 rows, 99.2% coverage, page-linked |
| Miscellaneous Fees & Levies Act (Cap. 469C) | `load-misc-levies.ts` | `obligations` (IDF 2.5%, RDL 2%) + `conditions` | ✅ loaded, page-linked |
| Finance Act 2026 | `load-finance-act.ts` | `amendments` (review queue) | ⏳ needs `tesseract` |
| EAC Gazette Routine Order No.2 | `load-routine-order.ts` | `conditions` (review) | ⏳ needs `tesseract` |

The source PDFs live in `public/docs/` so the app can serve them for the
page-linked references.

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

## Handy commands

```bash
npm run dev            # web app on http://localhost:3000
npm test               # run the hand-verified regression cases (fixtures/known-cases.json)
npm run db:studio      # browse the data in Prisma Studio
npx tsx scripts/assess.ts "<sentence, term, or HS code>" [value] [importer]
```

---

## How it's built

TypeScript / Node, Prisma, Next.js. Two Prisma schema variants
(`prisma/schema.postgres.prisma`, `prisma/schema.sqlite.prisma`) are selected onto
`prisma/schema.prisma` by `scripts/select-schema.ts`. The rules live in
`lib/assess.ts` (the deterministic engine), `lib/search.ts` (resolution), and
`lib/interpret.ts` (reading the sentence). Loaders are CLI scripts under
`/scripts` — never API routes.

### Key rules honoured (see `CLAUDE (3).md`)

- **Deterministic engine, never an LLM** for any rate, threshold or total.
- **Every figure cites `legalRef` + version + page.** A number that can't be traced
  to a document is a bug.
- **Sources are append-only.** A March 2025 declaration is assessed against the
  rules in force in March 2025 (`effectiveFrom` / `effectiveTo`).
- **Uncertain values are flagged (`needsReview`), never coerced.** A "sensitive
  item" or a compound rate blocks the total instead of guessing.
- **Finance Act amendments are never auto-applied** — they load into a human review
  queue, because deciding which rule they change is legal interpretation.

## Scope note on VAT / excise

Duty (CET), IDF and RDL (Cap. 469C) are loaded from their source PDFs. **VAT and
excise are intentionally absent** — their source Acts weren't provided, and we
don't invent a rate without a citable source. Add a loader for each Act to
populate those levy types.
