// The one place this application talks to the network.
//
// It sends an evidence pack (lib/ai/evidence.ts) built entirely from
// deterministic output, and asks for prose. It does not ask a question whose
// answer is a rate, a total, or whether something is compliant — CLAUDE.md rule
// 1 — and lib/ai/verify.ts checks the answer against the pack afterwards.

import Anthropic from "@anthropic-ai/sdk";

import { BRIEFING_MODEL, resolveKey } from "./config";
import type { EvidencePack } from "./evidence";
import { findIdentifiers } from "./redact";

export interface DraftedReport {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * The rules the model works under.
 *
 * Stable across every request, so it is cached — and it is written as
 * prohibitions rather than as a persona because the failure that matters is a
 * plausible number nobody can trace, not an unhelpful tone.
 */
const SYSTEM = `You write short briefing notes for a Kenya Revenue Authority customs officer who is deciding what to do with an item on their desk.

You are given a JSON evidence pack. It was produced by a deterministic rules engine that has already read the tariff and the relevant Acts. It is your ONLY permitted source of fact.

Absolute rules:
- Never state a rate, amount, percentage, HS code, page number or legal reference that does not appear in the evidence pack. Not one you calculated, not one you remember, not one that "should" apply.
- Never do arithmetic. If a figure is not in the pack, it is not available to you. Do not add charges together, do not convert, do not estimate.
- If "totalBlocked" is true there is NO total. Say plainly that a final total cannot be given yet, and say which charge is holding it up. Never offer an approximate, indicative or "roughly" figure.
- Anything in "flags" is there because the engine could not resolve it. Lead with those, do not soften them, and do not resolve them yourself.
- Never say whether the importer is compliant, whether the declared value is correct, or what the officer should decide. You describe what the law says applies; the judgement is theirs.
- Quote each figure exactly as the pack writes it, including the currency and the percent sign.
- Cite the legalRef, and the page where the pack gives one, next to the figure it supports.
- If the evidence is thin or the pack found no charges, say so. A short note that says little is correct when little is known.
- If "withheldDocuments" is above zero, that many documents on this machine were not shown to you. Say so plainly in "What is unresolved" and tell the officer to check them by hand. Never speculate about what they contain.

Write in plain English an officer can read in under a minute. No preamble, no restating these instructions, no closing pleasantries.

Use exactly these five headings, as markdown "## " headings, in this order:
## What this is
## What is chargeable
## What is unresolved
## Conditions to satisfy
## Recommended next step

Under "Recommended next step", list only verification actions the officer should take — documents to check, figures to confirm with a supervisor, conditions to evidence. Never a decision to release, detain, or assess.

Keep the whole note under 400 words.`;

/** Enough for a five-section note under 400 words, with room for the model to think. */
const MAX_TOKENS = 4000;

/**
 * Draft a briefing over an evidence pack.
 *
 * Throws a message meant for an officer to read, not a stack trace — every
 * failure here is an outbound network call going wrong, and the useful response
 * to that is always "the assessment above is unaffected".
 */
export async function draftBriefing(pack: EvidencePack): Promise<DraftedReport> {
  const { key } = resolveKey();
  if (!key) throw new Error("No API key is configured. Add one under Settings.");

  // Last check before anything leaves, over the one field in the pack that
  // originates with a person. Everything else is either a figure the engine
  // computed or text from a published document — running the identifier
  // patterns over those would flag the Finance Act's own section numbering and
  // block a legitimate briefing.
  //
  // buildEvidence() has already redacted this, so the check should never fire.
  // That is why it is worth having: if it does, something upstream changed.
  const identifiers = findIdentifiers(pack.item.query);
  if (identifiers.length) {
    throw new Error(
      `Blocked before sending: the item text contains something shaped like ${identifiers.join(", ")}. ` +
        `Nothing was sent. This is a bug — please report it.`
    );
  }

  const payload = JSON.stringify(pack, null, 2);

  const client = new Anthropic({ apiKey: key });

  try {
    const response = await client.messages.create({
      model: BRIEFING_MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `Evidence pack:\n\n${payload}\n\nWrite the briefing note.`,
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      throw new Error("The model declined to draft this briefing. The assessment above is unaffected.");
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) throw new Error("The model returned an empty briefing. Try again.");

    return {
      text,
      model: response.model,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
    };
  } catch (err) {
    throw new Error(explain(err));
  }
}

/** Turn an SDK error into something an officer can act on. Most specific first. */
function explain(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "The API key was rejected. Check it under Settings.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return "That API key does not have access to this model. Check the key's workspace under Settings.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Rate limited by the API. Wait a moment and try the briefing again.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Could not reach the API. This machine may be offline — the assessment above does not need a connection.";
  }
  if (err instanceof Anthropic.APIError) {
    return `The briefing service returned an error (${err.status}). The assessment above is unaffected.`;
  }
  return (err as Error).message || "The briefing could not be drafted.";
}
