// Second line of defence on anything that leaves the machine.
//
// The first line is the design: the briefing route never sends the officer's
// raw sentence. It sends what interpret() reduced that sentence to — an item
// phrase, a value and an importer type — plus deterministic output built from
// documents that are already public. Nothing else is assembled at all.
//
// But interpret() extracts an item phrase by stripping filler, and a sentence
// like "laptop for Otieno Traders, entry 2026-4471" leaves residue in it. So the
// phrase is scrubbed too. CLAUDE.md: never send trader names, TINs, or entry
// numbers to any external service.

export interface ScrubPattern {
  name: string;
  re: RegExp;
}

/**
 * Identifier shapes that must never leave. Exported so scripts/verify-ai-report.ts
 * asserts against exactly the same list the redactor applies — two copies of
 * this would drift, and the copy in the test is the one that would look right.
 *
 * Patterns are held without the global flag and recompiled per use, because a
 * shared /g regex carries `lastIndex` between calls and silently starts matching
 * from wherever the previous call stopped.
 */
export const SCRUB_PATTERNS: ScrubPattern[] = [
  // KRA PIN: A123456789X. Listed before the generic digit-run rule so it is
  // reported as a PIN rather than as an anonymous number.
  { name: "kra-pin", re: /\b[A-Za-z]\d{9}[A-Za-z]\b/ },
  { name: "email", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/ },
  // Kenyan mobile and international forms: 0712345678, +254712345678.
  { name: "phone", re: /(?:\+\d{1,3}[\s-]?)?\b0\d{8,11}\b/ },
  // "entry 2026-4471", "declaration no. C12345", "manifest 8842/A".
  { name: "entry-number", re: /\b(?:entry|declaration|decl|manifest|ucr)\b[\s.:#-]*(?:no\.?|number)?[\s.:#-]*[A-Za-z0-9/-]{3,}/i },
  // Any remaining run of 7+ digits. A customs value travels as a number in its
  // own field and never reaches this function, so a long digit run inside an
  // item phrase is an identifier, not a price.
  { name: "long-number", re: /\b\d{7,}\b/ },
];

/** An HS code is a legitimate item query and must survive the digit rules above. */
const HS_CODE = /\b\d{4}\.\d{2}\.\d{2}\b/g;

/** Sentinel an HS code is parked under while the scrubbers run. */
const HS_SLOT = (i: number) => ` HSCODE${i}X `;

/** How much item phrase is ever worth sending. Longer than this is not an item. */
const MAX_TERM = 120;

const PLACEHOLDER = "[redacted]";

/**
 * Strip identifier-shaped text from a term bound for the API, and cap its length.
 *
 * HS codes are parked first — `8471.30.00` would otherwise be eaten by a digit
 * rule — then restored once the scrubbers have run.
 */
export function redactTerm(input: string): string {
  if (!input) return "";

  const codes: string[] = [];
  let working = input.replace(HS_CODE, (m) => HS_SLOT(codes.push(m) - 1));

  for (const { re } of SCRUB_PATTERNS) {
    working = working.replace(new RegExp(re.source, `${re.flags}g`), PLACEHOLDER);
  }

  working = working
    .replace(/HSCODE(\d+)X/g, (whole, i) => codes[Number(i)] ?? whole)
    .replace(/\s+/g, " ")
    .trim();

  return working.length > MAX_TERM ? working.slice(0, MAX_TERM).trim() : working;
}

/**
 * Which identifier shapes a string still contains, by pattern name.
 *
 * Used by scripts/verify-ai-report.ts to assert an assembled evidence pack is
 * clean, and by lib/ai/report.ts as a last check before a request goes out.
 */
export function findIdentifiers(text: string): string[] {
  const guarded = text.replace(HS_CODE, " ");
  return SCRUB_PATTERNS.filter(({ re }) => new RegExp(re.source, re.flags).test(guarded)).map((p) => p.name);
}
