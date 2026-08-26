import { NextResponse } from "next/server";
import { searchLaw } from "@/lib/search";

// "Search the law": full-text search across every loaded document. Give it a
// phrase or a whole pasted paragraph (e.g. copied from the Finance Act) and get
// back the matching provisions/tariff lines with their source and page, so each
// can be opened at the exact page. No PII is accepted or logged here.
export async function POST(req: Request) {
  try {
    const { query } = await req.json();
    if (!query || typeof query !== "string" || query.trim().length < 2) {
      return NextResponse.json({ error: "Enter some text to search for." }, { status: 400 });
    }
    const hits = await searchLaw(query);
    return NextResponse.json({ hits });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
