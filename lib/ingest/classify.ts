// Deciding what kind of document this is, before trying to parse it.
//
// The taxonomy is the one in CLAUDE.md:
//   A  schedule with a text layer   -> tariff rows
//   B  scanned, no text layer       -> OCR first, then re-classify on the text
//   C  amending Act                 -> contains NO rates; a review queue
//   D  circular / notice            -> conditions, not rates
//
// Every decision records the counts behind it. A user who has just dropped in a
// hundred PDFs is entitled to see why one of them was called a tariff schedule
// and another was not, rather than being handed a verdict.

import type { PdfPage } from "../pdf/types";

export type DocType = "A" | "B" | "C" | "D";

export interface Classification {
  docType: DocType;
  /** Why, in a sentence a person can read. */
  reason: string;
  evidence: {
    pagesSampled: number;
    charsPerPage: number;
    hsRateRows: number;
    hsMentions: number;
    amendmentSentences: number;
    conditionSentences: number;
  };
  /** True when the text came from OCR, so the caller can note confidence. */
  scanned: boolean;
}

/**
 * What the document calls itself, read from its opening pages.
 *
 * Table density alone cannot tell a base tariff from a gazette notice, and the
 * difference matters more than any other call this makes: an EAC Routine Order
 * is mostly rows of HS codes and rates, and looks exactly like a tariff
 * schedule by the numbers — but it carries time-bound measures that CLAUDE.md
 * says must never be auto-applied. What separates them is what the document
 * announces itself to be on page one, so that is read first and outranks
 * density.
 */
// Order matters: the first marker to appear wins. The tariff is checked before
// the gazette because the CET's own front matter cites the gazette it was
// published in — a document that calls itself the customs tariff IS the tariff,
// wherever it was published.
const SELF_DESCRIPTION: { re: RegExp; docType: DocType; label: string }[] = [
  { re: /\b(common external tariff|customs tariff|tariff schedule)\b/i, docType: "A", label: "a customs tariff" },
  { re: /\b(routine order|legal notice|public notice|circular|practice note|gazette notice)\b/i, docType: "D", label: "a gazette notice or circular" },
  { re: /\barrangement of sections\b|\bCAP\.\s*\d|\bAN ACT of Parliament\b/i, docType: "D", label: "an Act of Parliament" },
];

/** How many opening pages to read for a self-description. */
const HEADER_PAGES = 3;

/** An HS code and a rate on the same visual row — the signature of a tariff schedule. */
const HS_RATE_ROW = /\b\d{4}\.\d{2}\.\d{2}\b.*?(\b\d{1,3}\s*%|\bFree\b|\bSI\b)/i;
const HS_MENTION = /\b\d{4}\.\d{2}(?:\.\d{2})?\b/;
const AMENDMENT_SENTENCE = /\bis\s+amended\b/i;
const CONDITION_SENTENCE =
  /\b(PVoC|pre-?export verification|certificate of conformity|shall not be imported|prohibited|restricted|exempt(?:ion|ed)?)\b/i;

/**
 * Classify a document from its extracted text.
 *
 * `scanned` says whether the text arrived via OCR; that alone decides B, and the
 * content decides between A, C and D either way. A scanned tariff schedule is
 * still a tariff schedule — the distinction that matters downstream is what the
 * document contains, with the extraction route recorded alongside.
 */
export function classify(
  pageText: string[],
  scanned: boolean,
  /**
   * The text came from a spreadsheet (lib/office). Its columns are given, not
   * inferred, so a short rate table is as clearly a schedule as a long one.
   */
  opts: { tabular?: boolean } = {}
): Classification {
  let hsRateRows = 0;
  let hsMentions = 0;
  let amendmentSentences = 0;
  let conditionSentences = 0;
  let chars = 0;

  for (const text of pageText) {
    chars += text.length;
    for (const line of text.split("\n")) {
      if (HS_RATE_ROW.test(line)) hsRateRows++;
      else if (HS_MENTION.test(line)) hsMentions++;
    }
    amendmentSentences += (text.match(/\bis\s+amended\b/gi) ?? []).length;
    for (const sentence of text.split(/(?<=\.)\s+/)) {
      if (CONDITION_SENTENCE.test(sentence)) conditionSentences++;
    }
  }

  const pagesSampled = pageText.length || 1;
  const evidence = {
    pagesSampled,
    charsPerPage: Math.round(chars / pagesSampled),
    hsRateRows,
    hsMentions,
    amendmentSentences,
    conditionSentences,
  };

  // An amending Act is a diff against other statutes and contains no rates of
  // its own — the single most important thing to get right here, because
  // treating one as a rate source is how a wrong duty reaches a total. Checked
  // before the self-description, since a Finance Act calls itself an Act.
  if (amendmentSentences >= 5 && amendmentSentences > hsRateRows) {
    return {
      docType: "C",
      reason:
        `Reads as an amending Act: ${amendmentSentences} "is amended" instructions and ` +
        `${hsRateRows} priced rows. These carry no rates of their own — every instruction ` +
        `goes to human review.`,
      evidence,
      scanned,
    };
  }

  const rowsPerPage = hsRateRows / pagesSampled;

  // What the document says it is, from its opening pages.
  const header = pageText.slice(0, HEADER_PAGES).join("\n");
  for (const marker of SELF_DESCRIPTION) {
    if (!marker.re.test(header)) continue;
    const dense = hsRateRows >= 20 && rowsPerPage >= 3;
    return {
      docType: marker.docType,
      reason:
        `Its opening pages identify it as ${marker.label}` +
        (marker.docType === "D" && dense
          ? `. It does carry ${hsRateRows} rows with an HS code and a rate, but a notice ` +
            `states measures against the tariff rather than being the tariff, so those go ` +
            `to review rather than becoming rates.`
          : `, and ${hsRateRows} rows carry an HS code and a rate.`),
      evidence,
      scanned,
    };
  }

  // A spreadsheet of tariff lines. The PDF threshold below exists to tell a
  // schedule from a circular quoting a few tariff lines in its prose; a
  // spreadsheet has no prose to quote them in, so a dozen priced rows that make
  // up most of what carries an HS code are a schedule. Proposals still go to
  // review like any other.
  if (opts.tabular && hsRateRows >= 3 && hsRateRows >= hsMentions) {
    return {
      docType: "A",
      reason:
        `A spreadsheet of tariff lines: ${hsRateRows} rows carry an HS code and a rate, ` +
        `and nothing in it identifies it as a notice or an Act.`,
      evidence,
      scanned,
    };
  }

  // Nothing named itself. Fall back to structure: a tariff schedule is dominated
  // by priced rows. The threshold is low in absolute terms but requires them to
  // be a real presence per page — a circular quoting three tariff lines is not a
  // schedule.
  if (hsRateRows >= 20 && rowsPerPage >= 3) {
    return {
      docType: "A",
      reason:
        `Reads as a tariff schedule: ${hsRateRows} rows carry an HS code and a rate ` +
        `(about ${rowsPerPage.toFixed(0)} per page across ${pagesSampled}), and nothing ` +
        `in its opening pages identifies it as a notice or an Act.`,
      evidence,
      scanned,
    };
  }

  if (conditionSentences >= 3) {
    return {
      docType: "D",
      reason:
        `Reads as a circular or notice: ${conditionSentences} passages state a requirement, ` +
        `restriction or exemption, and only ${hsRateRows} carry a rate.`,
      evidence,
      scanned,
    };
  }

  if (scanned && evidence.charsPerPage < 200) {
    return {
      docType: "B",
      reason:
        `Scanned, and OCR recovered little text (about ${evidence.charsPerPage} characters a page). ` +
        `It is searchable, but nothing was confidently extracted from it.`,
      evidence,
      scanned,
    };
  }

  return {
    docType: "D",
    reason:
      `No tariff rows, amendment instructions or stated conditions were found ` +
      `(${hsRateRows} priced rows, ${amendmentSentences} amendments across ${pagesSampled} pages). ` +
      `Filed as a notice: fully searchable, nothing extracted.`,
    evidence,
    scanned,
  };
}

/** Convenience for callers holding PdfPages rather than text. */
export function classifyPages(pages: PdfPage[], pageText: string[], scanned: boolean): Classification {
  void pages;
  return classify(pageText, scanned);
}
