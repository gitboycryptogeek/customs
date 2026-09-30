import { prisma } from "./db";
import { isFullHsCode, hsDigits } from "./hs";
import { dbProvider } from "./provider";

export type ResolutionMethod = "exact" | "alias" | "fulltext" | "miss";

export interface Resolution {
  method: ResolutionMethod;
  hsCode: string | null;
  description: string | null;
  candidates?: { hsCode: string; description: string; rank: number }[];
}

/**
 * Resolve free text or a code to an HS code. Coverage, not reasoning.
 * Order is fixed: exact code -> alias (whole phrase, then a keyword in it)
 * -> full-text -> logged miss. No LLM: this is deterministic string matching.
 */
export async function resolveHsCode(input: string): Promise<Resolution> {
  const q = input.trim();

  // 1. Exact HS code — the real, unambiguous answer in customs.
  if (isFullHsCode(q)) {
    const desc = await descriptionFor(hsDigits(q));
    return { method: "exact", hsCode: q, description: desc };
  }

  // 2. Alias table. First the whole phrase, then keywords inside it, so a
  //    natural sentence like "importing a laptop" still lands on the "laptop"
  //    alias. Longer keyphrases are tried before single words.
  const aliasHit = await matchAlias(q);
  if (aliasHit) {
    const desc = await descriptionFor(hsDigits(aliasHit));
    return { method: "alias", hsCode: aliasHit, description: desc };
  }

  // 3. Full-text over descriptions.
  const rows = dbProvider() === "sqlite" ? await fullTextSqlite(q) : await fullTextPostgres(q);
  if (rows.length > 0) {
    const top = rows[0];
    return {
      method: "fulltext",
      hsCode: formatHs(top.hsprefix),
      description: top.text,
      candidates: rows.map((r) => ({ hsCode: formatHs(r.hsprefix), description: r.text, rank: r.rank })),
    };
  }

  // 4. Nothing found — log the miss. This backlog feeds the alias table.
  await prisma.searchMiss.create({ data: { query: q } });
  return { method: "miss", hsCode: null, description: null };
}

/**
 * Try the alias table on the full phrase, then on adjacent word-pairs, then on
 * single significant words (longest candidates first). Returns the HS code of
 * the first match, or null.
 */
async function matchAlias(q: string): Promise<string | null> {
  const whole = q.toLowerCase();
  const exact = await prisma.alias.findUnique({ where: { term: whole } });
  if (exact) return exact.hsCode;

  const words = whole
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (words.length === 0) return null;

  const candidates: string[] = [];
  for (let i = 0; i < words.length - 1; i++) candidates.push(`${words[i]} ${words[i + 1]}`); // bigrams
  // Single-word aliases only when the phrase reduces to ONE significant word.
  // With several words (e.g. "cement clinker") full-text picks the most specific
  // line — a lone "cement" alias must not hijack it.
  if (words.length === 1) candidates.push(words[0]);
  const unique = [...new Set(candidates)];

  const found = await prisma.alias.findMany({ where: { term: { in: unique } } });
  if (found.length === 0) return null;
  // Pick the highest-confidence, then longest, match for determinism.
  found.sort((a, b) => b.confidence - a.confidence || b.term.length - a.term.length);
  return found[0].hsCode;
}

/** Postgres: tsvector + ts_rank over the generated GIN-indexed column. */
async function fullTextPostgres(q: string): Promise<{ hsprefix: string; text: string; rank: number }[]> {
  return prisma.$queryRaw<{ hsprefix: string; text: string; rank: number }[]>`
    SELECT "sectionRef" AS hsprefix, text,
           ts_rank(tsv, websearch_to_tsquery('english', ${q})) AS rank
    FROM chunks
    WHERE tsv @@ websearch_to_tsquery('english', ${q})
      AND "sectionRef" ~ '^[0-9]{6,8}$'
    ORDER BY rank DESC
    LIMIT 5;
  `;
}

/**
 * SQLite: full-text over the FTS5 index, then the project's own ranking.
 *
 * The index does the narrowing — without it this scans every chunk in the
 * database with a `LIKE '%word%'` per keyword, which is fine at four documents
 * and fatal at a hundred. The final ordering is still ours: most distinct
 * keywords matched, ties broken by the shorter description, so the most
 * specific tariff line wins. bm25 is only used to bound the candidate set, and
 * it is a pure function of the index, so the whole thing stays deterministic.
 */
async function fullTextSqlite(q: string): Promise<{ hsprefix: string; text: string; rank: number }[]> {
  const words = significantWords(q);
  if (words.length === 0) return [];

  const rows = (await ftsCandidates(words, CANDIDATE_LIMIT, true)) ?? (await likeCandidates(words));
  return rankByKeywords(rows, words).slice(0, 5);
}

/** How many index hits to rank in process. Far above any realistic result set. */
const CANDIDATE_LIMIT = 2000;

/**
 * Whether the FTS index exists, probed once per process.
 *
 * Checked rather than discovered by letting queries fail: a failed raw query is
 * logged by the Prisma client on every single search, which turns a supported
 * fallback into a wall of error output that hides real problems.
 */
let ftsProbe: Promise<boolean> | null = null;

function ftsAvailable(): Promise<boolean> {
  if (!ftsProbe) {
    ftsProbe = prisma
      .$queryRawUnsafe(`SELECT rowid FROM chunks_fts LIMIT 1`)
      .then(() => true)
      .catch(() => false);
  }
  return ftsProbe;
}

/**
 * Ask the FTS index for chunks matching any keyword.
 *
 * Returns null when the index is not present — a database that predates the
 * migration, or a SQLite build without FTS5 — so callers can fall back rather
 * than fail. Search degrading to slow is recoverable; search erroring is not.
 */
async function ftsCandidates(
  words: string[],
  limit: number,
  tariffOnly: boolean
): Promise<{ hsprefix: string; text: string }[] | null> {
  if (!(await ftsAvailable())) return null;
  // Words are already reduced to [a-z0-9], so they cannot carry FTS5 operator
  // syntax; quoting them keeps that true even if the filter is ever loosened.
  const match = words.map((w) => `"${w}"`).join(" OR ");
  const tariffFilter = tariffOnly
    ? `AND c."sectionRef" GLOB '[0-9]*' AND length(c."sectionRef") BETWEEN 6 AND 8`
    : "";
  try {
    return await prisma.$queryRawUnsafe<{ hsprefix: string; text: string }[]>(
      `SELECT c."sectionRef" AS hsprefix, c.text AS text
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
          ${tariffFilter}
        ORDER BY bm25(chunks_fts)
        LIMIT ${limit}`,
      match
    );
  } catch {
    return null;
  }
}

/** Pre-index fallback: the original scan. Correct, just slow. */
async function likeCandidates(words: string[]): Promise<{ hsprefix: string; text: string }[]> {
  return prisma.$queryRawUnsafe<{ hsprefix: string; text: string }[]>(
    `SELECT "sectionRef" AS hsprefix, text
       FROM chunks
      WHERE "sectionRef" GLOB '[0-9]*'
        AND length("sectionRef") BETWEEN 6 AND 8
        AND (${words.map(() => "lower(text) LIKE ?").join(" OR ")})`,
    ...words.map((w) => `%${w}%`)
  );
}

/** Most distinct keywords first; ties to the shorter, more specific description. */
function rankByKeywords(
  rows: { hsprefix: string; text: string }[],
  words: string[]
): { hsprefix: string; text: string; rank: number }[] {
  const scored = rows.map((r) => {
    const t = r.text.toLowerCase();
    return {
      hsprefix: r.hsprefix,
      text: r.text,
      rank: words.filter((w) => t.includes(w)).length,
      len: r.text.length,
    };
  });
  scored.sort((a, b) => b.rank - a.rank || a.len - b.len);
  return scored.map(({ hsprefix, text, rank }) => ({ hsprefix, text, rank }));
}

// Small stopword set for keyword extraction — deterministic, no NLP library.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "this", "that", "our", "your",
  "importing", "import", "imported", "goods", "item", "items", "product",
  "products", "worth", "valued", "value", "buy", "buying", "want", "need",
  "please", "some", "any", "one", "new", "used",
]);

export interface LawHit {
  sourceTitle: string;
  sourceFile: string | null;
  page: number | null;
  hsCode: string | null; // set when the chunk is a tariff line
  snippet: string;
  matched: number; // how many query keywords this chunk contains
}

/**
 * "Search the law": find where a pasted paragraph or phrase appears in the loaded
 * documents. Unlike item resolution this uses OR semantics — a chunk ranks by how
 * many of the query's keywords it contains — because a pasted legal paragraph
 * shares only some words with the provision you are after. Returns the best
 * matches with their source and page so the UI can deep-link into the PDF.
 * Deterministic, no model.
 *
 * The candidate set comes from the full-text index rather than from every chunk
 * in the database. This function used to load the whole table and score it in
 * memory, which is survivable at four documents and is not at a hundred — and
 * adding documents is now something a user does from inside the app.
 */
export async function searchLaw(
  input: string,
  limit = 15,
  /**
   * Restrict the search to these source versions. Undefined/null searches
   * everything, which is what the UI does. The AI layer passes a list here so a
   * document somebody added on this machine is not read out to an external
   * service — see lib/ai/scope.ts.
   */
  onlySourceVersions?: string[] | null
): Promise<LawHit[]> {
  const words = significantWords(input).slice(0, 30);
  if (words.length === 0) return [];

  const ids = await lawCandidateIds(words);
  const where = {
    ...(ids ? { id: { in: ids } } : {}),
    ...(onlySourceVersions ? { sourceVersionId: { in: onlySourceVersions } } : {}),
  };
  const chunks = await prisma.chunk.findMany({
    where: Object.keys(where).length ? where : undefined,
    select: {
      id: true,
      text: true,
      sectionRef: true,
      sourcePage: true,
      sourceVersion: { select: { title: true, sourceFile: true } },
    },
    // Only reached on the fallback path, where `ids` is null: keep the work
    // bounded rather than pulling an entire corpus into memory.
    take: ids ? undefined : LAW_SCAN_CAP,
  });

  const scored = chunks
    .map((c) => {
      const t = c.text.toLowerCase();
      const matched = words.filter((w) => t.includes(w)).length;
      return { c, matched };
    })
    .filter((s) => s.matched > 0)
    .sort((a, b) => b.matched - a.matched || a.c.text.length - b.c.text.length);

  return scored.slice(0, limit).map(({ c, matched }) => {
    const isHs = c.sectionRef && /^[0-9]{6,8}$/.test(c.sectionRef);
    return {
      sourceTitle: c.sourceVersion.title,
      sourceFile: c.sourceVersion.sourceFile ?? null,
      page: c.sourcePage ?? null,
      hsCode: isHs ? formatHs(c.sectionRef as string) : null,
      snippet: c.text.length > 400 ? c.text.slice(0, 397).trim() + "…" : c.text,
      matched,
    };
  });
}

/** Cap on the pre-index fallback scan. */
const LAW_SCAN_CAP = 20000;

/**
 * Chunk ids matching any keyword, or null when no index is available.
 *
 * Postgres has its own full-text column and is handled by fullTextPostgres for
 * item resolution; for the law search the FTS index is the SQLite path, and
 * null simply means "score what you can".
 */
async function lawCandidateIds(words: string[]): Promise<string[] | null> {
  if (dbProvider() !== "sqlite") return null;
  if (!(await ftsAvailable())) return null;
  const match = words.map((w) => `"${w}"`).join(" OR ");
  try {
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT c.id AS id
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY bm25(chunks_fts)
        LIMIT ${CANDIDATE_LIMIT}`,
      match
    );
    return rows.map((r) => r.id);
  } catch {
    return null;
  }
}

/** Significant lowercase words for matching: alphanumeric, >2 chars, not a stopword, de-duped. */
function significantWords(input: string): string[] {
  return [
    ...new Set(
      input
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    ),
  ];
}

async function descriptionFor(digits: string): Promise<string | null> {
  // Longest matching stored chunk description.
  for (const len of [8, 6, 4]) {
    if (digits.length < len) continue;
    const chunk = await prisma.chunk.findFirst({
      where: { sectionRef: digits.slice(0, len) },
    });
    if (chunk) return chunk.text;
  }
  return null;
}

function formatHs(digits: string): string {
  if (digits.length === 8) return `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6, 8)}`;
  if (digits.length === 6) return `${digits.slice(0, 4)}.${digits.slice(4, 6)}`;
  return digits;
}
