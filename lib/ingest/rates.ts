// Reading a rate off a tariff line. One implementation, shared by every parser.
//
// This is the single most dangerous piece of string handling in the project:
// getting it wrong produces a plausible number with a legal citation attached.
// The rules from CLAUDE.md are absolute and encoded here rather than repeated
// in each parser:
//
//   - "SI" (Sensitive Item) means the real rate lives in CET Annex I / Schedule
//     2. It is NOT zero. rate = null, needsReview = true.
//   - "Free" genuinely is zero.
//   - A compound "75% or $345/MT, whichever is higher" cannot be resolved
//     without the quantity, so the ad valorem part is kept but flagged, and no
//     total may be built on it.
//   - Anything else unparseable returns null. Never coerce to 0.

export interface ParsedRate {
  /** Ad valorem rate as a fraction (0.25 = 25%), or null when not determinable. */
  rate: number | null;
  /** Free-form text of a non-ad-valorem or compound rate, kept verbatim for a human. */
  specificRate: string | null;
  needsReview: boolean;
  /** True when the source said "SI" — the rate is elsewhere, and is not zero. */
  isSI: boolean;
}

/**
 * Parse the rate token(s) at the end of a tariff row.
 * Returns null when the text is not a rate at all (so the caller can skip the
 * line rather than record a wrong figure).
 */
export function parseRate(tail: string): ParsedRate | null {
  // Normalise "100 %" -> "100%", "$ 460" -> "$460" for matching.
  const t = tail.replace(/(\d)\s+%/g, "$1%").replace(/\$\s+/g, "$").trim();

  if (/^SI$/i.test(t)) return { rate: null, specificRate: null, needsReview: true, isSI: true };
  if (/^Free$/i.test(t)) return { rate: 0, specificRate: null, needsReview: false, isSI: false };

  // Decimals too: IDF is 2.5%, and a spreadsheet shows 0.125 formatted as a
  // percentage as "12.5%". Rejecting those dropped the row outright.
  const av = t.match(/^(\d{1,3}(?:\.\d{1,4})?)%/);
  if (!av) return null;
  const rate = Number(av[1]) / 100;

  // Compound "higher of ad valorem or specific" (e.g. "75% or $345/MT").
  // Keep the ad valorem rate but flag it: resolving the higher-of needs the
  // specific unit rate and the quantity, so a total must not be returned.
  if (/\bor\b/i.test(t) && /(\/MT|USD|\$)/i.test(t)) {
    return { rate, specificRate: t, needsReview: true, isSI: false };
  }
  return { rate, specificRate: null, needsReview: false, isSI: false };
}

/** Unit-of-quantity column that trails a description ("... - Other   u   25%"). */
export const UNIT_COLUMN =
  /\s{2,}(kg|Kg|u|l|L|m|t|MT|g|ml|No\.?|pairs|Pairs|Ns|m2|m3|1000u|2u|doz|pcs|km)\s*$/;
