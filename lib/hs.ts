// HS-code helpers. In customs, a full code is 8 digits grouped 4.2.2:
//   8471.30.00  ->  chapter 8471, heading 8471.30, item 8471.30.00
// Rules mostly attach at chapter/heading level, so matching is "longest prefix wins".

export const HS_FULL = /^\d{4}\.\d{2}\.\d{2}$/;

/** Strip dots/spaces -> digit string. "8471.30.00" -> "84713000". */
export function hsDigits(code: string): string {
  return code.replace(/[^\d]/g, "");
}

/** Is this a fully-qualified 8-digit dotted HS code? */
export function isFullHsCode(input: string): boolean {
  return HS_FULL.test(input.trim());
}

/**
 * All prefixes of an HS code, longest first, for longest-prefix-match lookup.
 * "84713000" -> ["84713000","847130","8471"] plus "" (global levies).
 * We match at the customs-meaningful boundaries: 8, 6, 4 digits.
 */
export function hsPrefixes(code: string): string[] {
  const d = hsDigits(code);
  const out: string[] = [];
  for (const len of [8, 6, 4]) {
    if (d.length >= len) out.push(d.slice(0, len));
  }
  out.push(""); // "" prefix = applies to every import (e.g. IDF, RDL)
  return out;
}

/** Normalise a dotted code to its canonical digit-prefix stored in obligations. */
export function normalizePrefix(code: string): string {
  return hsDigits(code);
}
