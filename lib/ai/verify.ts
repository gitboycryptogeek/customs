// Check a drafted briefing back against the evidence it was built from.
//
// CLAUDE.md rule 1: the rules engine is deterministic code, never an LLM, and
// model output has no audit trail. The briefing is allowed to exist because it
// only restates figures the engine already produced — so that claim has to be
// something the app checks rather than something the prompt asks for politely.
//
// The rule is deliberately blunt: **the model may only use numbers it was
// handed.** Every numeric token anywhere in the serialised pack is permitted;
// anything else in the prose is reported. That admits some noise (a year inside
// a document title is allowed because the title was in the pack) and no false
// negatives, which is the right way round — rule 4, flagged rather than guessed.

import type { EvidencePack } from "./evidence";
import type { Finding } from "./audit";
import type { ToolCall } from "./tools";

export interface Verification {
  ok: boolean;
  /** Figures in the briefing with no counterpart in the evidence. */
  unsupported: string[];
  /** How many figures were checked, so "0 problems" can be told from "nothing checked". */
  checked: number;
}

/** Percentages, KES amounts, bare thousands-separated figures, and HS codes. */
const CLAIM_PATTERNS: RegExp[] = [
  /\b\d+(?:\.\d+)?\s*%/g,
  /\bKES\s*[\d,]+(?:\.\d+)?/gi,
  /\b\d{4}\.\d{2}(?:\.\d{2})?\b/g,
  /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g,
];

/**
 * Reduce a figure to what it actually asserts, so "KES 6,750", "6,750" and
 * "6750" all compare equal. Percentages keep their sign so "16%" can never be
 * satisfied by a stray "16" in a page number.
 */
function normalise(token: string): string {
  const t = token.trim().toLowerCase();
  if (t.endsWith("%")) {
    const n = Number(t.replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? `${n}%` : t;
  }
  const digits = t.replace(/^kes\s*/, "").replace(/,/g, "");
  const n = Number(digits);
  // An HS code is not a quantity — keep it as written so 8471.30 and 8471.3
  // are different things.
  if (/^\d{4}\.\d{2}/.test(digits)) return digits;
  return Number.isFinite(n) ? String(n) : t;
}

/**
 * Every figure the pack contains, in normalised form.
 *
 * Built by scanning the serialised JSON rather than by listing fields: a field
 * added to the pack later would otherwise be sent to the model but not admitted
 * by the verifier, and the failure would look like the model hallucinating.
 */
function allowedFigures(pack: EvidencePack): Set<string> {
  const json = JSON.stringify(pack);
  const allowed = new Set<string>();

  for (const re of CLAIM_PATTERNS) {
    for (const m of json.matchAll(re)) allowed.add(normalise(m[0]));
  }
  // Plain integers too — rates arrive as "16%" but page numbers, years and
  // whole-shilling amounts appear bare.
  for (const m of json.matchAll(/\b\d+(?:\.\d+)?\b/g)) {
    allowed.add(normalise(m[0]));
    // A rate written "0.16" in the pack is the same claim as "16%" in prose.
    const n = Number(m[0]);
    if (Number.isFinite(n) && n > 0 && n <= 1) allowed.add(`${Number((n * 100).toFixed(4))}%`);
  }
  return allowed;
}

/**
 * Verify a drafted briefing against its evidence.
 *
 * Returns the unsupported figures rather than throwing: the officer is shown the
 * briefing either way, with the check's result attached. Hiding a briefing that
 * failed would leave a person wondering why nothing happened; showing it
 * unlabelled would be worse than not offering the feature.
 */
export function verifyReport(text: string, pack: EvidencePack): Verification {
  const allowed = allowedFigures(pack);
  const seen = new Set<string>();
  const unsupported: string[] = [];

  for (const re of CLAIM_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const raw = m[0].trim();
      if (seen.has(raw)) continue;
      seen.add(raw);
      if (!allowed.has(normalise(raw))) unsupported.push(raw);
    }
  }

  return { ok: unsupported.length === 0, unsupported, checked: seen.size };
}

// ---------------------------------------------------------------------------
// Audit mode
// ---------------------------------------------------------------------------

export interface FindingVerification {
  ok: boolean;
  /** Findings that survived: every citation resolves to a row a tool actually returned. */
  kept: Finding[];
  /** Findings dropped, with why. Shown to the officer — a silent drop hides a malfunction. */
  dropped: { statement: string; reason: string }[];
}

/**
 * Check findings against the tool log.
 *
 * In audit mode the model chooses what it reads, so there is no fixed pack to
 * compare figures against. The tool log takes its place: a finding is
 * admissible only if the row ids it cites were actually returned by a query
 * that actually ran. That turns "the model says there is an unapplied
 * amendment" into "row cm3x… was returned by find_amendments at turn 2", which
 * is a thing an officer can open.
 *
 * A "confirms" finding is exempt from needing a citation — reporting that
 * nothing was found is a legitimate result of a query that returned nothing,
 * and there is no row id for an absence.
 */
export function verifyFindings(findings: Finding[], toolCalls: ToolCall[]): FindingVerification {
  const seenIds = new Set(toolCalls.flatMap((c) => c.rowIds));
  const kept: Finding[] = [];
  const dropped: { statement: string; reason: string }[] = [];

  if (toolCalls.length === 0) {
    return {
      ok: false,
      kept: [],
      dropped: findings.map((f) => ({ statement: f.statement, reason: "no database query was ever run" })),
    };
  }

  for (const f of findings) {
    if (f.kind === "confirms" && f.citations.length === 0) {
      kept.push(f);
      continue;
    }
    if (f.citations.length === 0) {
      dropped.push({ statement: f.statement, reason: "cites no row" });
      continue;
    }
    const unknown = f.citations.filter((id) => !seenIds.has(id));
    if (unknown.length === f.citations.length) {
      dropped.push({
        statement: f.statement,
        reason: `cites ${unknown.length === 1 ? "an id" : "ids"} no query returned`,
      });
      continue;
    }
    // Partially-cited findings are kept with the bad ids stripped: the real row
    // behind it is still worth an officer's attention, and dropping the whole
    // finding over one bad id loses more than it protects.
    kept.push({ ...f, citations: f.citations.filter((id) => seenIds.has(id)) });
  }

  return { ok: dropped.length === 0, kept, dropped };
}
