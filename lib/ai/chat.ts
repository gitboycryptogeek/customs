// Conversational mode.
//
// This is the feature CLAUDE.md says the AI layer "does not exist to" provide —
// answering a question — so it is worth being exact about how it can exist here
// without breaking rule 1.
//
// It does not answer from the model's knowledge. Every turn, the server runs the
// deterministic pipeline FIRST over what the user asked (interpret ->
// resolveHsCode -> assess, plus searchLaw for passages) and the model is handed
// that result as its only permitted source. It may restate, explain, compare and
// say what is missing. It may not produce a rate, a total, or a compliance
// judgement that is not already in the grounding — and `verifyReport()` checks
// every figure it wrote against the grounding before an officer sees it, exactly
// as for a briefing.
//
// So the difference from `draftBriefing()` is the shape of the request, not the
// trust model: a briefing writes up one assessment in five fixed headings, and
// this answers the question that was actually asked over the same evidence.
//
// Two groundings, because a conversation asks two kinds of question:
//
//   "a laptop worth 150,000 for my company"  -> resolves to an HS code and a
//        value, so the engine can assess it and the grounding is a full
//        EvidencePack, figures and all.
//   "what is IDF charged on?"                -> resolves to nothing chargeable,
//        so the grounding is law passages only. The model explains the law and
//        has no figures to quote, which is the correct outcome rather than a
//        degraded one.

import Anthropic from "@anthropic-ai/sdk";

import { BRIEFING_MODEL, resolveKey } from "./config";
import { findIdentifiers } from "./redact";
import type { EvidencePack, EvidencePassage } from "./evidence";

/** How many turns of history to send. Bounded: an unbounded chat is an unbounded bill. */
export const MAX_HISTORY_TURNS = 12;

const MAX_TOKENS = 3000;

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * What the model is allowed to use this turn.
 *
 * `pack` is present when the question resolved to something the engine could
 * assess. `passages` is always present — for a general question it is the whole
 * grounding.
 */
export interface ChatGrounding {
  question: string;
  pack: EvidencePack | null;
  passages: EvidencePassage[];
  documentsLoaded: { title: string; issuer: string; docType: string }[];
  withheldDocuments: number;
  rulesAsAt: string;
  /** Why there is no assessment, when there is none. Shown to the model and the user. */
  noAssessmentReason: string | null;
}

export interface ChatAnswer {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/*
 * The system prompt is a frozen string and is the first thing in the request, so
 * it is a stable cache prefix. A chat resends it on every turn, which is exactly
 * the shape prompt caching exists for — see the cache_control breakpoint below.
 * Do not interpolate anything into it.
 */
const SYSTEM = `You are helping a customs officer in Kenya understand an assessment that has ALREADY been calculated by deterministic software.

You are a narrator, not a calculator and not an adjudicator.

Absolute rules:
- Every figure you state — any percentage, any KES amount, any HS code — MUST appear verbatim in the GROUNDING for this turn. Never compute a new figure, never add charges together yourself, never convert or estimate.
- If the grounding has no assessment, you have no figures. Explain what the law passages say and state plainly that no chargeable assessment was produced for this question. Do not supply a rate from memory.
- Never say whether someone is compliant, and never say what they owe as a conclusion of your own. Report what the engine produced and what remains unresolved.
- When a charge is flagged as needing review, or a total is blocked, say so explicitly and do not offer a total.
- If documents were withheld from you, say that your view is partial and name how many. Never give a clean bill of health over material you could not read.
- If the question cannot be answered from the grounding, say so and say what would answer it (a document to load, a value to supply).

Style: answer the question that was asked, directly, in plain English an officer can act on. Short paragraphs. Use a bulleted list when you are enumerating charges or conditions. Cite the legal reference and page beside a figure the way the grounding gives them. No preamble, no restating the question, no sign-off.`;

/**
 * Answer one question over one turn's grounding.
 *
 * History is included for continuity of phrasing and follow-ups ("what about for
 * a company?"), but it is NOT evidence: the grounding is rebuilt server-side
 * every turn, so a figure can never survive from an earlier turn into a later
 * answer without the engine having produced it again.
 */
export async function answerQuestion(grounding: ChatGrounding, history: ChatTurn[]): Promise<ChatAnswer> {
  const { key } = resolveKey();
  if (!key) throw new Error("No API key is configured. Add one under Settings.");

  // The question is the one field here that originates with a person. It has
  // already been scrubbed by the caller; this is the assertion that it was.
  const identifiers = findIdentifiers(grounding.question);
  if (identifiers.length) {
    throw new Error(
      `Blocked before sending: your question contains something shaped like ${identifiers.join(", ")}. ` +
        `Nothing was sent. Remove it and ask again.`
    );
  }

  const client = new Anthropic({ apiKey: key });

  const trimmed = history.slice(-MAX_HISTORY_TURNS);
  const messages: Anthropic.MessageParam[] = trimmed.map((t) => ({ role: t.role, content: t.text }));

  // The grounding rides with the question rather than in the system prompt: it
  // changes every turn, and anything that changes must sit after the last cache
  // breakpoint or it invalidates the cached prefix on every request.
  messages.push({
    role: "user",
    content: `GROUNDING (your only permitted source for this turn):\n${JSON.stringify(
      {
        assessment: grounding.pack,
        noAssessmentReason: grounding.noAssessmentReason,
        lawPassages: grounding.passages,
        documentsLoaded: grounding.documentsLoaded,
        documentsWithheldFromYou: grounding.withheldDocuments,
        rulesAsAt: grounding.rulesAsAt,
      },
      null,
      2
    )}\n\nQUESTION: ${grounding.question}`,
  });

  try {
    const response = await client.messages.create({
      model: BRIEFING_MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      // Frozen prefix, cached. A chat pays for this prompt on every turn
      // otherwise, and it is the largest stable thing in the request.
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages,
    });

    if (response.stop_reason === "refusal") {
      throw new Error("The model declined to answer that. Any assessment shown is unaffected.");
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) throw new Error("The model returned an empty answer. Nothing has changed.");

    return {
      text,
      model: response.model,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      cacheReadTokens: response.usage?.cache_read_input_tokens ?? null,
      cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? null,
    };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      throw new Error("That API key was rejected. Check it under Settings.");
    }
    if (e instanceof Anthropic.RateLimitError) {
      throw new Error("Rate limited by the API. Wait a moment and ask again.");
    }
    if (e instanceof Anthropic.APIError) {
      throw new Error(`The API call failed (${e.status}). Any assessment shown is unaffected.`);
    }
    throw e;
  }
}
