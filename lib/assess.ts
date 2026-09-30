import { prisma } from "./db";
import { hsPrefixes, hsDigits, isFullHsCode } from "./hs";
import { levyLabel, basisLabel, ratePct, money, shortDescription } from "./labels";
import { Prisma } from "@prisma/client";
import type { Obligation } from "@prisma/client";

/** Exact decimal arithmetic for money. Ships with Prisma; no extra dependency. */
const Decimal = Prisma.Decimal;

export type ImporterType = "private" | "company" | "government" | "ngo" | string;

export interface AssessLine {
  type: string;
  rate: number | null;
  specificRate?: string | null;
  basis: string;
  amount: number | null;
  legalRef: string;
  sourceVersionId: string;
  sourceFile: string | null; // served PDF filename for a deep link, or null
  page: number | null; // 1-based page in that PDF, or null
  needsReview: boolean;
}

export interface AssessFlag {
  severity: "high" | "medium" | "low";
  message: string;
}

export interface AssessResult {
  hsCode: string;
  description: string | null;
  plainSummary: string[]; // the result in everyday English, one sentence per entry
  lines: AssessLine[];
  total: number | null; // null when any contributing line needs review / has null rate
  conditions: { type: string; detail: string; legalRef: string; sourceFile: string | null; page: number | null }[];
  flags: AssessFlag[];
  rulesAsAt: Date;
}

// Deterministic order in which levies stack. VAT is computed last because its
// base (cif_plus_duty) depends on the duty/excise/levy lines above it.
const TYPE_ORDER = ["duty", "excise", "idf", "rdl", "vat"];

/**
 * Deterministic assessment. No LLM anywhere: same inputs -> same output, and
 * that output must survive a trader's legal challenge. Every line cites a
 * legalRef + sourceVersionId. Never returns a total built on a needs_review or
 * null-rate line — returns the partial breakdown plus a flag instead.
 */
export async function assess(
  hsCodeInput: string,
  customsValue: number,
  importerType: ImporterType = "private",
  asAt: Date = new Date()
): Promise<AssessResult> {
  if (!isFullHsCode(hsCodeInput)) {
    // Callers should resolve to a full code first; be strict here.
    throw new Error(`assess() requires a full HS code (dddd.dd.dd), got "${hsCodeInput}"`);
  }
  const digits = hsDigits(hsCodeInput);
  const prefixes = hsPrefixes(digits);

  // Pull every effective obligation whose prefix is an ancestor of this code.
  const obligations = await prisma.obligation.findMany({
    where: {
      hsPrefix: { in: prefixes },
      effectiveFrom: { lte: asAt },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asAt } }],
    },
    include: { sourceVersion: true },
  });

  const flags: AssessFlag[] = [];

  // Longest-prefix-match wins, per levy type. When the source lists the SAME
  // prefix+type more than once (the CET does this for a few items), we must not
  // pick nondeterministically: choose a stable order AND flag the conflict so no
  // total is returned on an ambiguous rate.
  const prefixRank = new Map(prefixes.map((p, i) => [p, prefixes.length - i])); // longer prefix -> higher
  type Ob = Obligation & { sourceVersion: { effectiveTo: Date | null; sourceFile: string | null } };
  const byType = new Map<string, Ob[]>();
  for (const o of obligations) {
    const arr = byType.get(o.type) ?? [];
    arr.push(o as Ob);
    byType.set(o.type, arr);
  }
  const conflictedTypes = new Set<string>();
  const bestByType = new Map<string, Ob>();
  for (const [type, arr] of byType) {
    const topRank = Math.max(...arr.map((o) => prefixRank.get(o.hsPrefix) ?? 0));
    const top = arr.filter((o) => (prefixRank.get(o.hsPrefix) ?? 0) === topRank);
    // Deterministic tie-break: highest rate first (nulls last), then id.
    top.sort((a, b) => {
      const ra = a.rate === null ? -1 : Number(a.rate);
      const rb = b.rate === null ? -1 : Number(b.rate);
      if (rb !== ra) return rb - ra;
      return a.id.localeCompare(b.id);
    });
    bestByType.set(type, top[0]);
    if (top.length > 1) conflictedTypes.add(type);
  }
  const lines: AssessLine[] = [];
  // Money is computed in exact decimal, not binary floating point.
  //
  // These figures are meant to survive a trader's legal challenge, and a levy
  // charged on "the value plus the duty already added" compounds whatever error
  // the line above it carried. 0.1 + 0.2 is famously not 0.3 in binary; a duty
  // schedule is full of rates like 2.5% that have no exact binary form. Decimal
  // arithmetic removes the question entirely, and the conversion to a plain
  // number happens once, at the JSON boundary.
  let runningBase = new Decimal(customsValue); // for cif_plus_duty accumulation
  const value = new Decimal(customsValue);

  const orderedTypes = [
    ...TYPE_ORDER.filter((t) => bestByType.has(t)),
    ...[...bestByType.keys()].filter((t) => !TYPE_ORDER.includes(t)),
  ];

  for (const type of orderedTypes) {
    const o = bestByType.get(type)!;
    // Prisma hands back a Decimal; keep it exact rather than widening to float.
    const rateDecimal = o.rate === null ? null : new Decimal(o.rate.toString());
    const rate = rateDecimal === null ? null : rateDecimal.toNumber();
    const base = o.basis === "cif_plus_duty" ? runningBase : value;
    const amountDecimal = rateDecimal === null ? null : rateDecimal.times(base).toDecimalPlaces(2);
    const amount = amountDecimal === null ? null : amountDecimal.toNumber();
    const conflicted = conflictedTypes.has(type);
    const needsReview = o.needsReview || rate === null || conflicted;
    if (conflicted) {
      flags.push({
        severity: "high",
        message: `${levyLabel(type)}: the source shows more than one possible rate for this item, so we can't be sure which one applies. An officer needs to confirm the correct rate.`,
      });
    }

    lines.push({
      type,
      rate,
      specificRate: (o as any).specificRate ?? null,
      basis: o.basis,
      amount,
      legalRef: o.legalRef,
      sourceVersionId: o.sourceVersionId,
      sourceFile: o.sourceVersion.sourceFile ?? null,
      page: o.sourcePage ?? null,
      needsReview,
    });

    if (amountDecimal !== null && o.basis !== "cif_plus_duty") {
      runningBase = runningBase.plus(amountDecimal);
    }

    if (rate === null) {
      flags.push({
        severity: "high",
        message: `${levyLabel(type)}: the tariff doesn't give a fixed rate for this item (it's treated as a "sensitive item"), so an officer must set the rate before a final total can be shown.`,
      });
    }
    if ((o as any).specificRate) {
      flags.push({
        severity: "high",
        message: `${levyLabel(type)}: this item has a two-part rate — a percentage, or a fixed amount per unit, whichever is higher (${(o as any).specificRate}). We've used the percentage; an officer must check the per-unit amount in case it's higher.`,
      });
    }
    if (o.sourceVersion.effectiveTo && o.sourceVersion.effectiveTo <= asAt) {
      flags.push({
        severity: "medium",
        message: `${levyLabel(type)}: this figure comes from a version of the law that has since been replaced — double-check it's still current.`,
      });
    }
  }

  if (lines.length === 0) {
    flags.push({
      severity: "high",
      message: "We couldn't find an import duty for this HS code. Check that the code is correct, or the tariff for it may not be loaded yet.",
    });
  }

  // Conditions (PVoC, restrictions, exemptions) matching prefix + importer type.
  const conditionRows = await prisma.condition.findMany({
    where: {
      hsPrefix: { in: prefixes },
      effectiveFrom: { lte: asAt },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asAt } }],
      AND: [
        {
          OR: [{ appliesToImporterType: null }, { appliesToImporterType: importerType }],
        },
      ],
    },
    include: { sourceVersion: true },
  });
  const conditions = conditionRows.map((c) => ({
    type: c.conditionType,
    detail: c.detail,
    legalRef: c.legalRef,
    sourceFile: c.sourceVersion.sourceFile ?? null,
    page: c.sourcePage ?? null,
  }));
  if (conditionRows.some((c) => c.conditionType === "pvoc")) {
    flags.push({
      severity: "medium",
      message: "This item may need a PVoC certificate — a quality check done in the country of export before the goods are shipped. See the conditions below.",
    });
  }

  // Total: only when every contributing line is clean. Otherwise null + flag.
  const hasBlocker = lines.some((l) => l.needsReview || l.amount === null);
  let total: number | null = null;
  if (lines.length > 0 && !hasBlocker) {
    total = lines
      .reduce((sum, l) => sum.plus(l.amount ?? 0), new Decimal(0))
      .toDecimalPlaces(2)
      .toNumber();
  } else if (hasBlocker) {
    const which = lines.filter((l) => l.needsReview || l.amount === null).map((l) => levyLabel(l.type));
    flags.push({
      severity: "high",
      message: `We can't give a final total yet because ${joinList(which)} still ${which.length > 1 ? "need" : "needs"} an officer to confirm. Everything we could work out is shown below.`,
    });
  }

  const description = await descriptionFor(digits);

  // The whole result in everyday English — one short sentence per entry.
  const plainSummary: string[] = [];
  plainSummary.push(`You're looking at ${shortDescription(description)} (HS code ${hsCodeInput}).`);
  for (const l of lines) {
    const label = levyLabel(l.type);
    if (l.rate === null) {
      plainSummary.push(`${label}: no fixed rate is set for this item, so an officer must supply it.`);
    } else if (l.amount !== null && !l.needsReview) {
      plainSummary.push(`${label}: ${ratePct(l.rate)} of ${basisLabel(l.basis)} = KES ${money(l.amount)}.`);
    } else {
      plainSummary.push(`${label}: ${ratePct(l.rate)}, but the amount can't be finalised yet — see the notes below.`);
    }
  }
  if (lines.length === 0) {
    plainSummary.push("We couldn't find any taxes or levies for this item — the code or tariff may need checking.");
  } else if (total !== null) {
    plainSummary.push(
      `Estimated total taxes and levies: KES ${money(total)} on a declared value of KES ${money(customsValue)}.`
    );
  } else {
    plainSummary.push("We can't give a final total yet — one or more charges above need an officer to confirm.");
  }

  return { hsCode: hsCodeInput, description, plainSummary, lines, total, conditions, flags, rulesAsAt: asAt };
}

/** Join a list into readable English: ["A"] -> "A", ["A","B"] -> "A and B", ["A","B","C"] -> "A, B and C". */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

async function descriptionFor(digits: string): Promise<string | null> {
  for (const len of [8, 6, 4]) {
    if (digits.length < len) continue;
    const chunk = await prisma.chunk.findFirst({ where: { sectionRef: digits.slice(0, len) } });
    if (chunk) return chunk.text;
  }
  return null;
}
