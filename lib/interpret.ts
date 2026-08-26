// Turn a plain-English sentence into the three things the deterministic engine
// needs: the item to look up, the customs value, and the importer type. This is
// pure pattern-matching — NOT an LLM. It only *reads* the sentence; the rates,
// thresholds and arithmetic still come entirely from the rules engine, so the
// same sentence always yields the same lookup. It "feels like" talking to an AI
// without any model deciding anything about compliance.
//
//   "importing a laptop worth 150,000 for my company"
//     -> { itemQuery: "laptop", customsValue: 150000, importerType: "company" }

export interface Interpretation {
  raw: string;
  itemQuery: string;
  customsValue: number | null;
  importerType: string; // always set; defaults to "private"
  importerExplicit: boolean; // did the sentence actually name an importer type?
}

/** Words/phrases that carry no lookup meaning; stripped from the item phrase. */
const FILLER = [
  "i want to import", "i'm importing", "i am importing", "i want to bring in",
  "i would like to import", "looking to import", "planning to import",
  "importing", "import", "bringing in", "bring in", "buying", "buy",
  "worth", "valued at", "value of", "costing", "priced at", "of value",
  "for my", "for a", "for an", "as a", "as an", "for", "please", "kindly",
  "a ", "an ", "the ", "some ", "my ",
];

export function interpret(text: string): Interpretation {
  const raw = text.trim();
  let working = ` ${raw.toLowerCase()} `;

  // 1. Customs value.
  const { value, matchStr } = extractValue(raw);
  if (matchStr) working = working.replace(matchStr.toLowerCase(), " ");

  // 2. Importer type.
  const { importerType, matched, importerExplicit } = extractImporter(working);
  for (const m of matched) working = working.replace(new RegExp(`\\b${m}\\b`, "gi"), " ");

  // 3. Item phrase: strip currency words and filler, collapse whitespace.
  working = working.replace(/\b(kes|kshs?|ksh|shillings?|bob|sh)\b/gi, " ").replace(/\/=/g, " ");
  for (const f of FILLER) working = working.split(f).join(" ");
  const itemQuery = working.replace(/[,.]/g, " ").replace(/\s+/g, " ").trim();

  return {
    raw,
    itemQuery: itemQuery || raw,
    customsValue: value,
    importerType,
    importerExplicit,
  };
}

/**
 * Pull a money amount out of the sentence. Prefers a number sitting next to a
 * currency word (KES, shillings, /=) or carrying a k/m suffix; otherwise the
 * largest plausible number (>= 1000, so quantities like "10 kg" aren't mistaken
 * for a value). Returns the parsed value and the exact substring matched (so the
 * caller can remove it from the item phrase).
 */
export function extractValue(text: string): { value: number | null; matchStr: string | null } {
  const re =
    /(kes|kshs?|ksh|shillings?|bob)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|thousand|million)?\s*(\/=|kes|kshs?|ksh|shillings?|bob)?/gi;
  let best: { value: number; str: string; score: number } | null = null;

  for (const m of text.matchAll(re)) {
    const digits = m[2]?.replace(/,/g, "");
    if (!digits || !/\d/.test(digits)) continue;
    let v = parseFloat(digits);
    if (!isFinite(v)) continue;

    const suffix = (m[3] || "").toLowerCase();
    if (suffix === "k" || suffix === "thousand") v *= 1_000;
    if (suffix === "m" || suffix === "million") v *= 1_000_000;

    const hasCurrency = Boolean(m[1] || m[4] || suffix);
    // Ignore small bare numbers (weights, quantities); accept any currency-tagged one.
    if (!hasCurrency && v < 1000) continue;

    const score = (hasCurrency ? 1e15 : 0) + v; // currency-tagged wins, else biggest number
    if (!best || score > best.score) best = { value: v, str: m[0].trim(), score };
  }
  return best ? { value: best.value, matchStr: best.str } : { value: null, matchStr: null };
}

/** Classify the importer type from keywords. Defaults to private. */
export function extractImporter(text: string): {
  importerType: string;
  matched: string[];
  importerExplicit: boolean;
} {
  const t = ` ${text.toLowerCase()} `;
  const rules: { type: string; words: string[] }[] = [
    { type: "ngo", words: ["ngo", "charity", "charitable", "non-profit", "nonprofit", "not-for-profit"] },
    { type: "government", words: ["government", "govt", "ministry", "county", "parastatal", "public sector"] },
    { type: "company", words: ["company", "companies", "business", "ltd", "limited", "firm", "corporation", "corporate", "enterprise"] },
    { type: "private", words: ["private", "individual", "personal", "myself", "home use", "personal use"] },
  ];
  for (const r of rules) {
    const hit = r.words.filter((w) => new RegExp(`\\b${w}\\b`).test(t));
    if (hit.length) return { importerType: r.type, matched: hit, importerExplicit: true };
  }
  return { importerType: "private", matched: [], importerExplicit: false };
}
