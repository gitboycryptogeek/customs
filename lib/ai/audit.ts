// Audit mode: the model interrogates the database and reports what it finds.
//
// The quick briefing (lib/ai/report.ts) restates a finished assessment. This
// does something different and more useful: it goes looking for what the
// assessment could not show. The engine has known blind spots, all of them
// deliberate —
//
//   - longest-prefix-match takes ONE obligation row per levy type, so a second
//     row at the same prefix, or one at a broader prefix, never appears;
//   - a Finance Act's amendments sit unapplied in a queue by design, so a levy
//     that has legally changed still shows its old rate;
//   - a parser's proposal waits in staging for a person, invisible to assess();
//   - a source version can be superseded without every figure drawn from it
//     being revisited.
//
// Each of those is correct behaviour and each is something an officer would
// want to know about. Finding them means querying the database, which means
// tools (lib/ai/tools.ts) and a loop.
//
// What does NOT change: the model decides nothing. It emits findings, each
// citing rows it actually read, and lib/ai/verify.ts throws out any citation
// that does not resolve. The assessment, the total and the rules engine are
// untouched — CLAUDE.md rule 1 is not relaxed for this mode, it is enforced by
// the fact that nothing here can write.

import Anthropic from "@anthropic-ai/sdk";

import { BRIEFING_MODEL, resolveKey } from "./config";
import type { EvidencePack } from "./evidence";
import { findIdentifiers } from "./redact";
import { TOOLS, runTool, type ToolCall } from "./tools";
import { documentScope, type DocumentScope } from "./scope";

/** What one finding asserts. */
export type FindingKind =
  /** The database agrees with the assessment. Worth saying — a clean audit is a result. */
  | "confirms"
  /** A row exists that contradicts, or competes with, a figure the assessment used. */
  | "discrepancy"
  /** Something applies that the assessment does not show at all. */
  | "addition"
  /** A figure traces to a version that has been replaced. */
  | "stale"
  /** An amendment or staged row is waiting on a person and would change this if applied. */
  | "unreviewed";

export interface Finding {
  kind: FindingKind;
  severity: "high" | "medium" | "low";
  /** What was observed. Never a decision, never a corrected rate stated as fact. */
  statement: string;
  /** Row ids from tool results. Checked; a finding citing nothing real is dropped. */
  citations: string[];
  /** What the officer should do about it. A verification step, never an outcome. */
  officerAction: string;
  /** Present only when the finding is concrete enough to propose into the review queue. */
  proposal?: {
    kind: "obligation" | "condition";
    hsPrefix: string;
    legalRef: string;
    reason: string;
    [key: string]: unknown;
  };
}

export interface AuditResult {
  summary: string;
  findings: Finding[];
  toolCalls: ToolCall[];
  model: string;
  turns: number;
  inputTokens: number;
  /** Tokens served from the prompt cache across the run, and tokens written to it. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Set when the loop stopped on a cap rather than because the model finished. */
  truncated: boolean;
}

/**
 * Hard caps. An agentic loop resends its whole history every turn, so cost grows
 * quadratically with turns — and an audit that will not stop is a bill, not a
 * feature. These bound it whatever the model does.
 */
const MAX_TURNS = 8;
const MAX_TOOL_CALLS = 20;
const MAX_TOKENS = 8000;

const SYSTEM = `You are auditing a customs assessment for a Kenya Revenue Authority officer.

A deterministic rules engine has already produced the assessment. It is not your job to redo it, restate it, or correct it. Your job is to query the database behind it and report what the officer CANNOT see in the result on their screen.

The engine's deliberate blind spots — look for these specifically:
- It applies longest-prefix-match and takes ONE obligation row per levy type. A competing row at the same prefix, or one at a broader prefix, is invisible. Check with get_obligations.
- Amendments from a Finance Act are NEVER auto-applied. One with applied=false that targets a levy in this assessment means the figure on screen may be out of date. Check with find_amendments.
- Parser proposals sit in staging until a person approves them. One proposing a different rate for a line the assessment used is a live disagreement. Check with get_staged_rows.
- A source version can be superseded after figures were drawn from it. Check with list_documents.

Absolute rules:
- You decide NOTHING. You do not state a corrected rate as fact, you do not compute a total, you do not say whether the assessment is right or whether anyone is compliant. You report what is on record and what an officer should check.
- Every finding must cite the "id" values of rows you actually received from a tool. A finding you cannot cite must not be written. Do not invent an id.
- Never assert something you did not read. If a tool returned nothing, that is a finding of its own ("nothing on record"), not licence to reason from memory.
- An unapplied amendment has NOT changed any rate. Say it is unapplied and that an officer must decide; never say the rate "is now" something else.
- You may be told that documents on this machine are withheld from you. If so your view is partial: you cannot search them and your tools will not return their rows. Report that as a finding of kind "unreviewed" so the officer knows to check those documents by hand, and never guess at what they hold.
- If the database agrees with the assessment, say so with kind "confirms". A clean audit is a useful result and you should not manufacture problems to seem thorough.

Work by calling tools. Call several at once when they are independent. Stop as soon as you have checked the blind spots above — you have a limited number of turns and an audit that runs out of turns mid-check is worse than a short one that finished.

When done, reply with ONLY a JSON object, no prose around it and no code fence:

{
  "summary": "two sentences an officer reads first",
  "findings": [
    {
      "kind": "confirms" | "discrepancy" | "addition" | "stale" | "unreviewed",
      "severity": "high" | "medium" | "low",
      "statement": "what is on record",
      "citations": ["<row id from a tool result>"],
      "officerAction": "what to check",
      "proposal": {              // OPTIONAL. Only when a concrete row should be
        "kind": "condition",     // added, and only if you are confident. It goes
        "hsPrefix": "8471",      // to a human review queue, never into the rules.
        "legalRef": "...",
        "reason": "why this should be proposed",
        "conditionType": "pvoc" | "exemption" | "restriction",
        "detail": "..."
      }
    }
  ]
}

Order findings by severity, highest first.`;

/**
 * Run an audit over an assessment.
 *
 * The evidence pack is the starting context — what the officer is looking at.
 * Everything after that the model fetches itself.
 */
/**
 * Strip cache_control from every content block in the transcript.
 *
 * Called before setting the new breakpoint each turn. Without it the markers
 * accumulate and the fifth turn is rejected for exceeding the four-breakpoint
 * limit — which would surface as a 400 halfway through an audit, after the model
 * had already been paid for four turns.
 */
function clearCacheMarkers(messages: Anthropic.MessageParam[]): void {
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const block of m.content) {
      if ("cache_control" in block) delete (block as { cache_control?: unknown }).cache_control;
    }
  }
}

export async function runAudit(pack: EvidencePack, sharedScope?: DocumentScope): Promise<AuditResult> {
  const { key } = resolveKey();
  if (!key) throw new Error("No API key is configured. Add one under Settings.");

  // Same egress check as the briefing: the item phrase is the only field in the
  // pack that originated with a person.
  const identifiers = findIdentifiers(pack.item.query);
  if (identifiers.length) {
    throw new Error(
      `Blocked before sending: the item text contains something shaped like ${identifiers.join(", ")}. ` +
        `Nothing was sent. This is a bug — please report it.`
    );
  }

  // Resolved once, then threaded through every call. A scope that could change
  // halfway would make the tool log an unreliable record of what was shown.
  const scope = sharedScope ?? (await documentScope());

  const client = new Anthropic({ apiKey: key });
  const toolCalls: ToolCall[] = [];
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `Audit this assessment. It is what the officer currently sees:\n\n` +
        `${JSON.stringify(pack, null, 2)}\n\n` +
        `Query the database and report what it does not show.`,
    },
  ];

  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  let truncated = false;
  let finalText = "";

  try {
    while (turns < MAX_TURNS) {
      turns++;

      const response = await client.messages.create({
        model: BRIEFING_MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: TOOLS as unknown as Anthropic.Tool[],
        messages,
      });

      inputTokens += response.usage?.input_tokens ?? 0;
      // Worth accumulating rather than inferring: if these stay at zero across a
      // multi-turn run, something is silently invalidating the prefix and the
      // cache is costing more than it saves.
      cacheReadTokens += response.usage?.cache_read_input_tokens ?? 0;
      cacheWriteTokens += response.usage?.cache_creation_input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;

      if (response.stop_reason === "refusal") {
        throw new Error("The model declined to run this audit. The assessment is unaffected.");
      }

      // Thinking blocks must be echoed back unchanged on the same model, so the
      // whole content array goes back rather than just the text.
      messages.push({ role: "assistant", content: response.content });

      const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

      if (uses.length === 0) {
        finalText = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        break;
      }

      // Every tool_use gets a tool_result in ONE user message, even the ones
      // refused by the cap — a missing result is a malformed conversation, and
      // splitting them across messages teaches the model to stop batching.
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        if (toolCalls.length >= MAX_TOOL_CALLS) {
          truncated = true;
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content: "Tool-call limit reached. Report what you have found so far as JSON now.",
          });
          continue;
        }
        const call = await runTool(use.name, (use.input ?? {}) as Record<string, unknown>, scope);
        toolCalls.push(call);
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: Boolean(call.error),
          content: JSON.stringify(call.result),
        });
      }
      // Cache the history as it grows.
      //
      // The system prompt and the tool definitions are already a cached prefix,
      // but they are the SMALL half: an agentic loop resends the whole transcript
      // every turn, so by turn 6 most of the input is tool results this run
      // already paid for. A breakpoint on the newest tool_result makes turn N+1
      // read turns 1..N from cache instead of re-reading them at full price.
      //
      // Rolling, not accumulating: the API allows four breakpoints, and this loop
      // runs up to eight turns, so the previous turn's breakpoint is removed
      // before the new one is set. A cache read still matches the longest cached
      // prefix, so moving the marker forward each turn keeps the whole transcript
      // behind it eligible.
      clearCacheMarkers(messages);
      const last = results[results.length - 1];
      if (last) last.cache_control = { type: "ephemeral" };

      messages.push({ role: "user", content: results });

      if (turns === MAX_TURNS - 1) {
        messages.push({
          role: "user",
          content: "You have one turn left. Stop calling tools and reply with the JSON object now.",
        });
      }
    }
  } catch (err) {
    throw new Error(explain(err));
  }

  if (!finalText) {
    truncated = true;
    throw new Error(
      `The audit ran ${turns} turns without producing a report. Nothing was changed; try again, or use the quick briefing.`
    );
  }

  const parsed = parseFindings(finalText);
  return {
    summary: parsed.summary,
    findings: parsed.findings,
    toolCalls,
    model: BRIEFING_MODEL,
    turns,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    truncated,
  };
}

/**
 * Read the model's JSON reply.
 *
 * Tolerant about wrapping — a code fence or a sentence before the object is a
 * formatting slip, not a reason to lose an audit that already ran its queries.
 * Intolerant about shape: anything that is not a well-formed finding is dropped
 * rather than half-rendered.
 */
function parseFindings(text: string): { summary: string; findings: Finding[] } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { summary: text.slice(0, 500), findings: [] };
  }

  let raw: { summary?: unknown; findings?: unknown };
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { summary: text.slice(0, 500), findings: [] };
  }

  const kinds: FindingKind[] = ["confirms", "discrepancy", "addition", "stale", "unreviewed"];
  const severities = ["high", "medium", "low"] as const;

  const findings = (Array.isArray(raw.findings) ? raw.findings : [])
    .map((f): Finding | null => {
      const o = f as Record<string, unknown>;
      if (typeof o.statement !== "string" || !o.statement.trim()) return null;
      return {
        kind: kinds.includes(o.kind as FindingKind) ? (o.kind as FindingKind) : "addition",
        severity: severities.includes(o.severity as never) ? (o.severity as Finding["severity"]) : "medium",
        statement: o.statement,
        citations: Array.isArray(o.citations) ? o.citations.filter((c): c is string => typeof c === "string") : [],
        officerAction: typeof o.officerAction === "string" ? o.officerAction : "",
        proposal: isProposal(o.proposal) ? (o.proposal as Finding["proposal"]) : undefined,
      };
    })
    .filter((f): f is Finding => f !== null);

  const rank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return {
    summary: typeof raw.summary === "string" ? raw.summary : "",
    findings,
  };
}

function isProposal(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    (p.kind === "obligation" || p.kind === "condition") &&
    typeof p.hsPrefix === "string" &&
    typeof p.legalRef === "string" &&
    Boolean(p.legalRef)
  );
}

/** Turn an SDK error into something an officer can act on. Most specific first. */
function explain(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The API key was rejected. Check it under Settings.";
  if (err instanceof Anthropic.PermissionDeniedError) {
    return "That API key does not have access to this model. Check the key's workspace under Settings.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a moment and try again.";
  if (err instanceof Anthropic.APIConnectionError) {
    return "Could not reach the API. This machine may be offline — the assessment does not need a connection.";
  }
  if (err instanceof Anthropic.APIError) {
    return `The audit service returned an error (${err.status}). The assessment is unaffected.`;
  }
  return (err as Error).message || "The audit could not be completed.";
}
