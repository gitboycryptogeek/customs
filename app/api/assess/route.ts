import { NextResponse } from "next/server";
import { resolveHsCode } from "@/lib/search";
import { assess } from "@/lib/assess";
import { interpret } from "@/lib/interpret";
import { ensureReady } from "@/lib/startup";

// Deterministic assessment endpoint. No trader PII is accepted or logged here —
// only a plain-English item query / value / importer type. (Never send names,
// TINs, entry numbers.)
//
// The `query` may be a single term, an HS code, or a whole sentence like
// "importing a laptop worth 150,000 for my company" — interpret() pulls out the
// item, value and importer type deterministically (no LLM). Explicit
// customsValue / importerType in the body override what the sentence implies.
export async function POST(req: Request) {
  try {
    await ensureReady();
    const body = await req.json();
    const rawQuery: unknown = body.query;
    if (!rawQuery || typeof rawQuery !== "string") {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    const said = interpret(rawQuery);

    // Overrides from the optional fields win over what the sentence implied.
    const overrideValue = body.customsValue === "" || body.customsValue == null ? null : Number(body.customsValue);
    const value = overrideValue !== null && Number.isFinite(overrideValue) ? overrideValue : said.customsValue;
    const importerType = (typeof body.importerType === "string" && body.importerType) || said.importerType;

    const interpreted = { itemQuery: said.itemQuery, customsValue: value, importerType, importerExplicit: said.importerExplicit };

    if (value === null || !Number.isFinite(value) || value < 0) {
      return NextResponse.json({
        interpreted,
        resolution: null,
        assessment: null,
        needsValue: true,
      });
    }

    const resolution = await resolveHsCode(said.itemQuery);
    if (!resolution.hsCode) {
      return NextResponse.json({ interpreted, resolution, assessment: null });
    }
    const assessment = await assess(resolution.hsCode, value, importerType);
    return NextResponse.json({ interpreted, resolution, assessment });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
