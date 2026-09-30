import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { ensureReady } from "@/lib/startup";
import { isFullHsCode } from "@/lib/hs";

// Searches that found nothing, and turning them into shortcuts.
//
// CLAUDE.md calls this log the single highest-value thing in the project: it is
// the backlog that grows the alias table, and every entry is a real question
// somebody asked that the tool could not answer. It has never had a screen —
// which meant nobody was reviewing it weekly, as intended.

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureReady();

    const misses = await prisma.searchMiss.findMany({
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    // Group identical queries: the same miss asked ten times is one alias to
    // add, and the count is what says which to do first.
    const grouped = new Map<string, { query: string; count: number; lastSeen: Date }>();
    for (const m of misses) {
      const key = m.query.trim().toLowerCase();
      const existing = grouped.get(key);
      if (existing) {
        existing.count++;
        if (m.createdAt > existing.lastSeen) existing.lastSeen = m.createdAt;
      } else {
        grouped.set(key, { query: m.query.trim(), count: 1, lastSeen: m.createdAt });
      }
    }

    const terms = [...grouped.keys()];
    const covered = terms.length
      ? await prisma.alias.findMany({ where: { term: { in: terms } }, select: { term: true, hsCode: true } })
      : [];
    const coveredBy = new Map(covered.map((a) => [a.term, a.hsCode]));

    return NextResponse.json({
      misses: [...grouped.entries()]
        .map(([term, v]) => ({ ...v, term, resolvedTo: coveredBy.get(term) ?? null }))
        .sort((a, b) => b.count - a.count || +b.lastSeen - +a.lastSeen),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** Add a shortcut so this search resolves next time. */
export async function POST(req: Request) {
  try {
    await ensureReady();
    const { term, hsCode, addedBy } = await req.json();

    const cleanTerm = String(term ?? "").trim().toLowerCase();
    const cleanCode = String(hsCode ?? "").trim();

    if (!cleanTerm) {
      return NextResponse.json({ error: "A term is required." }, { status: 400 });
    }
    if (!isFullHsCode(cleanCode)) {
      return NextResponse.json(
        { error: "Enter a full HS code, like 8471.30.00." },
        { status: 400 }
      );
    }

    // The code must be one the tariff actually knows, or the shortcut would
    // resolve to an assessment with nothing behind it.
    const digits = cleanCode.replace(/[^\d]/g, "");
    const known = await prisma.obligation.findFirst({
      where: { hsPrefix: { in: [digits, digits.slice(0, 6), digits.slice(0, 4)] } },
      select: { id: true },
    });
    if (!known) {
      return NextResponse.json(
        { error: `Nothing is loaded for ${cleanCode}. Check the code, or add the tariff that covers it.` },
        { status: 400 }
      );
    }

    const alias = await prisma.alias.upsert({
      where: { term: cleanTerm },
      update: { hsCode: cleanCode, addedBy: addedBy || "review" },
      create: { term: cleanTerm, hsCode: cleanCode, addedBy: addedBy || "review", confidence: 1 },
    });

    return NextResponse.json({ ok: true, alias: { term: alias.term, hsCode: alias.hsCode } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
