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
 * SQLite: no tsvector. Deterministic tokenised scan — pull HS-description chunks
 * that contain any query keyword, then rank by how many distinct keywords match
 * (ties broken by shorter description, so the most specific line wins). Adequate
 * for the ~5,900 short CET descriptions and needs no SQLite extension.
 */
async function fullTextSqlite(q: string): Promise<{ hsprefix: string; text: string; rank: number }[]> {
  const words = q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (words.length === 0) return [];

  // GLOB '[0-9]*' keeps HS-code chunks; length filter keeps 6-8 digit refs.
  const rows = await prisma.$queryRawUnsafe<{ hsprefix: string; text: string }[]>(
    `SELECT "sectionRef" AS hsprefix, text
     FROM chunks
     WHERE "sectionRef" GLOB '[0-9]*'
       AND length("sectionRef") BETWEEN 6 AND 8
       AND (${words.map(() => "lower(text) LIKE ?").join(" OR ")})`,
    ...words.map((w) => `%${w}%`)
  );

  const scored = rows.map((r) => {
    const t = r.text.toLowerCase();
    const hits = words.filter((w) => t.includes(w)).length;
    return { hsprefix: r.hsprefix, text: r.text, rank: hits, len: r.text.length };
  });
  scored.sort((a, b) => b.rank - a.rank || a.len - b.len);
  return scored.slice(0, 5).map(({ hsprefix, text, rank }) => ({ hsprefix, text, rank }));
}

// Small stopword set for keyword extraction — deterministic, no NLP library.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "this", "that", "our", "your",
  "importing", "import", "imported", "goods", "item", "items", "product",
  "products", "worth", "valued", "value", "buy", "buying", "want", "need",
  "please", "some", "any", "one", "new", "used",
]);

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
