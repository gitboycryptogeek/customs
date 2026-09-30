// Whether the officer's briefing is switched on, and what key it uses.
//
// The rest of this app runs entirely offline. This module is the single place
// that decides an outbound HTTPS request is permitted at all, so it is
// deliberately boring: off unless somebody has explicitly turned it on and
// supplied a key.
//
// Settings live in a small JSON file in the writable per-user folder — the same
// place the user's database and their added PDFs go, because the app bundle is
// read-only. `ANTHROPIC_API_KEY` in the environment overrides the stored key,
// which is how `npm run dev` and a web deployment configure it without a file.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The model the briefing runs on. Pinned, not user-editable — see lib/ai/report.ts. */
export const BRIEFING_MODEL = "claude-opus-5";

export interface AiSettings {
  enabled: boolean;
  apiKey: string | null;
  /**
   * Let the AI read documents added on this machine, not just the four
   * published ones that ship with the app. Off by default — see lib/ai/scope.ts.
   */
  includeAddedDocuments: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** What the UI is allowed to know. Never carries the key itself. */
export interface AiStatus {
  /** A key is available from somewhere. */
  configured: boolean;
  /** Configured AND switched on — the only state in which a request may leave. */
  ready: boolean;
  enabled: boolean;
  model: string;
  keySource: "env" | "file" | null;
  /** Last four characters, so a person can tell which key is saved. */
  keyLast4: string | null;
  includeAddedDocuments: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

const EMPTY: AiSettings = {
  enabled: false,
  apiKey: null,
  includeAddedDocuments: false,
  updatedAt: null,
  updatedBy: null,
};

/**
 * Where the settings file lives.
 *
 * SETTINGS_DIR is set by electron/main.js to the per-user data directory. In
 * dev there is no Electron, so it falls back to the project root — which is
 * also where .env sits, and is already gitignored territory for local state.
 */
export function settingsPath(): string {
  return join(process.env.SETTINGS_DIR || process.cwd(), "ai-settings.json");
}

/**
 * Read the settings file. Deliberately NOT memoised.
 *
 * CLAUDE.md records that Next bundles each route file separately — that is why
 * the ingest queue had to be collapsed into a single route. A module-level cache
 * here would give /api/ai/settings and /api/ai/report two different views of the
 * same file: a key saved on the settings page would never be seen by the route
 * that needs it. The file is a few hundred bytes and is read once per briefing.
 */
export function readSettings(): AiSettings {
  const path = settingsPath();
  if (!existsSync(path)) return { ...EMPTY };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AiSettings>;
    return {
      enabled: parsed.enabled === true,
      apiKey: typeof parsed.apiKey === "string" && parsed.apiKey ? parsed.apiKey : null,
      // Anything but an explicit true is off. A corrupt or older settings file
      // must not widen what may leave the machine.
      includeAddedDocuments: parsed.includeAddedDocuments === true,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : null,
    };
  } catch {
    // A corrupt settings file must not take the app down, and must not be read
    // as "enabled". Fail closed.
    console.error("[ai] settings file is unreadable; treating the briefing as off");
    return { ...EMPTY };
  }
}

/** Write the settings file with owner-only permissions. */
export function writeSettings(next: AiSettings): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    // writeFileSync's mode only applies when it creates the file, so an existing
    // one keeps whatever permissions it had. Set it explicitly. No-op on Windows.
    chmodSync(path, 0o600);
  } catch {
    /* best effort — a filesystem without POSIX modes is not a reason to fail */
  }
}

/**
 * The key to call the API with, or null.
 *
 * The environment wins over the file so a deployment can supply the key without
 * one being written to disk at all.
 */
export function resolveKey(settings: AiSettings = readSettings()): { key: string | null; source: "env" | "file" | null } {
  const fromEnv = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  if (settings.apiKey) return { key: settings.apiKey, source: "file" };
  return { key: null, source: null };
}

/** Everything the UI may see. Never the key. */
export function aiStatus(): AiStatus {
  const settings = readSettings();
  const { key, source } = resolveKey(settings);
  // A key supplied through the environment is a deliberate act by whoever runs
  // the server, so it enables the feature on its own. A key sitting in the file
  // still needs the switch, because saving one and turning it on are two
  // separate decisions on the settings page.
  const enabled = settings.enabled || source === "env";
  return {
    configured: Boolean(key),
    ready: Boolean(key) && enabled,
    enabled,
    model: BRIEFING_MODEL,
    keySource: source,
    keyLast4: key ? key.slice(-4) : null,
    includeAddedDocuments: settings.includeAddedDocuments,
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
  };
}
