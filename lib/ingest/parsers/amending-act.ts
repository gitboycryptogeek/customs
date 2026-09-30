/**
 * Type C parser — amending Acts (any Finance Act).
 *
 * CRITICAL, and worth restating where the code lives: an amending Act contains
 * NO rates. It is a diff against other statutes:
 *
 *   "Section 8 of the Income Tax Act is amended by deleting subsection (5A)."
 *
 * So its output NEVER becomes an obligation. It becomes a human review queue.
 * Deciding which rule a given amendment changes is legal interpretation, and
 * silently getting that wrong is the worst failure this system has.
 *
 * The text is read via lib/pdf/margins, not from raw OCR output: these Acts
 * carry cross-references in a narrow margin column, and reading straight across
 * the page splices them into the middle of the operative sentence —
 * "...is amended in arene, subsection (1)" — which hides every amendment on the
 * page from any pattern looking for a whole sentence.
 */
import { bodyText } from "../../pdf/margins";
import type { PdfPage } from "../../pdf/types";

/**
 * The head of an amendment: "Section N of the X Act is amended…".
 *
 * The act name is deliberately restricted to letters, spaces and an optional
 * year — NOT `.+?`. Once the page is reflowed into one line (which it must be,
 * or a sentence wrapping across lines is invisible), an unbounded lazy capture
 * runs the length of the page hunting for the next "Act … is amended", swallows
 * several genuine amendments inside one bogus match, and reports an act name
 * that is actually three paragraphs of statute. Punctuation and digits are what
 * bound it, because real act names contain neither.
 */
const HEAD =
  /Section\s+(\d{1,3}[A-Z]{0,2}(?:\([0-9A-Za-z]+\))?)\s+of\s+the\s+([A-Z][A-Za-z'’\s]{2,60}?Act(?:,?\s*\d{4})?)\s+is\s+amended/g;

/** The operative verb inside an amendment body, whichever form the drafter used. */
const OPERATION = /\b(insert|add|delet|repeal|substitut|replac)[a-z]*ing\b/i;

/** How much text after a head to treat as its body when no further head follows. */
const MAX_BODY_CHARS = 1200;

export interface ParsedAmendment {
  targetAct: string;
  targetSection: string;
  operation: "insert" | "delete" | "substitute" | "amend";
  text: string;
  /** 1-based page it was found on, for the deep link back to the source. */
  page: number;
}

export function classifyOperation(word: string): ParsedAmendment["operation"] {
  const w = word.toLowerCase();
  if (w.startsWith("insert") || w.startsWith("add")) return "insert";
  if (w.startsWith("delet") || w.startsWith("repeal")) return "delete";
  if (w.startsWith("substitut") || w.startsWith("replac")) return "substitute";
  return "amend";
}

export interface AmendmentParseResult {
  amendments: ParsedAmendment[];
  stats: {
    pagesSeen: number;
    pagesWithMarginStripped: number;
    /** Sentences mentioning an amendment at all — the denominator for coverage. */
    amendmentMentions: number;
  };
}

/**
 * Extract amendments for the review queue.
 *
 * Works head-then-body rather than matching one sentence pattern. Drafters write
 * the same instruction several ways — "is amended by inserting…", "is amended in
 * subsection (1), by deleting…", "is amended — (a) in subsection 5…" — and a
 * single sentence regex catches only the first, silently dropping the rest. A
 * missed amendment is a law change nobody is told about, so each head claims the
 * text up to the next head and the operative verb is read from inside it.
 *
 * Runs per page so each amendment keeps the page it came from: an officer
 * reviewing one needs to open the original.
 */
export function parseAmendments(pages: PdfPage[]): AmendmentParseResult {
  const amendments: ParsedAmendment[] = [];
  let pagesWithMarginStripped = 0;
  let amendmentMentions = 0;

  for (const page of pages) {
    const body = bodyText(page);
    if (!body) continue;
    if (body.length < joinedLength(page)) pagesWithMarginStripped++;
    amendmentMentions += (body.match(/is\s+amended/gi) ?? []).length;

    const heads = [...body.matchAll(HEAD)];
    for (let i = 0; i < heads.length; i++) {
      const head = heads[i];
      const section = head[1].trim();
      const act = head[2].replace(/\s+/g, " ").trim();

      // The body runs to the next amendment head, so one instruction can never
      // absorb the next. Failing that, a bounded slice.
      const start = head.index ?? 0;
      const nextStart = heads[i + 1]?.index ?? body.length;
      const slice = body.slice(start, Math.min(nextStart, start + MAX_BODY_CHARS));

      const verb = slice.match(OPERATION);
      amendments.push({
        targetAct: act,
        targetSection: `Section ${section}`,
        // No recognisable verb means the instruction is there but its effect is
        // not mechanically clear — "amend" sends it to a human, which is where
        // it was always going anyway.
        operation: verb ? classifyOperation(verb[1]) : "amend",
        text: slice.replace(/\s+/g, " ").trim(),
        page: page.page,
      });
    }
  }

  return {
    amendments,
    stats: { pagesSeen: pages.length, pagesWithMarginStripped, amendmentMentions },
  };
}

function joinedLength(page: PdfPage): number {
  return page.items.reduce((n, i) => n + i.str.length + 1, 0);
}
