import { NextResponse } from "next/server";

import { aiStatus, readSettings, writeSettings } from "@/lib/ai/config";

// Turn the AI briefing on or off, and hold the API key.
//
// This is the switch on the only outbound network call the app makes, so both
// halves are deliberately narrow: GET never returns the key (only its last four
// characters, so a person can tell which one is saved), and POST accepts nothing
// but the key, the enabled flag, and who changed it.

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(aiStatus());
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const current = readSettings();

    // Three distinct intents, kept apart so "turn it off" can never be read as
    // "clear the key" and vice versa:
    //   { apiKey: "sk-…" }  save a key
    //   { apiKey: null }    remove the stored key
    //   { apiKey absent }   leave the key alone
    let apiKey = current.apiKey;
    if ("apiKey" in body) {
      if (body.apiKey === null || body.apiKey === "") {
        apiKey = null;
      } else if (typeof body.apiKey === "string") {
        const trimmed = body.apiKey.trim();
        if (!trimmed.startsWith("sk-ant-")) {
          return NextResponse.json(
            { error: "That doesn't look like an Anthropic API key — they start with \"sk-ant-\"." },
            { status: 400 }
          );
        }
        apiKey = trimmed;
      }
    }

    const enabled = typeof body.enabled === "boolean" ? body.enabled : current.enabled;
    const includeAddedDocuments =
      typeof body.includeAddedDocuments === "boolean" ? body.includeAddedDocuments : current.includeAddedDocuments;
    const updatedBy = typeof body.updatedBy === "string" && body.updatedBy.trim() ? body.updatedBy.trim() : current.updatedBy;

    // Removing the key switches the feature off too. Leaving `enabled` true with
    // nothing behind it would show officers a button that always errors.
    writeSettings({
      enabled: apiKey ? enabled : false,
      apiKey,
      includeAddedDocuments,
      updatedAt: new Date().toISOString(),
      updatedBy,
    });

    return NextResponse.json(aiStatus());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
