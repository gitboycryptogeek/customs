/**
 * Type D parser — circulars, notices and gazette orders.
 *
 * These yield conditions rather than rates: PVoC requirements, restricted
 * lists, exemption criteria, and time-bound measures against particular tariff
 * lines. Every one is a pointer for a person to read, not a rule to apply — an
 * EAC Routine Order can change a duty for a year, but deciding that it does is
 * legal interpretation, and CLAUDE.md puts that firmly out of scope for code.
 */

export type ConditionType = "pvoc" | "exemption" | "restriction";

const PATTERNS: { type: ConditionType; re: RegExp }[] = [
  { type: "pvoc", re: /\b(PVoC|pre-?export verification|certificate of conformity)\b/i },
  { type: "exemption", re: /\b(exempt(?:ion|ed)?|remission|shall not be charged|zero-?rated)\b/i },
  { type: "restriction", re: /\b(prohibit(?:ed|ion)?|restrict(?:ed|ion)?|shall not be imported|ban(?:ned)?)\b/i },
];

const HS_REF = /\b(\d{4}\.\d{2}\.\d{2}|\d{4}\.\d{2}|\d{2}\.\d{2})\b/;

export interface ParsedCondition {
  hsPrefix: string;
  conditionType: ConditionType;
  detail: string;
  page: number;
  confidence: number;
}

export interface ConditionParseResult {
  conditions: ParsedCondition[];
  /** Lines that referenced a tariff code or stated a requirement — the coverage denominator. */
  linesSeen: number;
}

/**
 * Pull candidate conditions out of a notice.
 *
 * A line qualifies if it either names a tariff line a measure applies to, or
 * states a requirement in words. Both kinds are recorded, with the ones doing
 * both marked as the clearest — that ordering is only used to put the vaguest
 * pointers in front of a reviewer last.
 */
export function parseConditions(pageText: string[], title: string): ConditionParseResult {
  void title;
  const conditions: ParsedCondition[] = [];
  let linesSeen = 0;

  pageText.forEach((text, i) => {
    const page = i + 1;
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\s+/g, " ").trim();
      if (line.length < 20) continue;

      const codeMatch = line.match(HS_REF);
      const typed = PATTERNS.find((p) => p.re.test(line));
      if (!codeMatch && !typed) continue;
      linesSeen++;

      conditions.push({
        hsPrefix: codeMatch ? codeMatch[1].replace(/[^\d]/g, "") : "",
        conditionType: typed?.type ?? "restriction",
        detail: line,
        page,
        confidence: codeMatch && typed ? 0.8 : typed ? 0.6 : 0.4,
      });
    }
  });

  return { conditions, linesSeen };
}
