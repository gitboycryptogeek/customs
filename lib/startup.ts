// One-time database preparation, run before the first query a request makes.
//
// This lives here rather than in Next's instrumentation.ts because that file is
// compiled for the edge runtime as well as Node, and the migration runner reads
// SQL files off disk — `node:fs` cannot be bundled for edge, which breaks
// `npm run dev` outright. Route handlers are unambiguously Node, so the work is
// triggered from there instead.
//
// The promise is memoised, so this costs one check per request and does the real
// work once per process.

import { migrate } from "./migrate";

let ready: Promise<void> | null = null;

/** Bring the database up to date. Safe and cheap to call on every request. */
export function ensureReady(): Promise<void> {
  if (!ready) {
    ready = migrate()
      .then((result) => {
        if (result.applied.length) {
          console.log(`[startup] migrations applied: ${result.applied.join(", ")}`);
        }
        if (!result.ftsAvailable) {
          console.warn("[startup] full-text index unavailable — search will use the slower scan");
        }
      })
      .catch((err) => {
        // A migration failure must not stop the app answering questions: the
        // lookup path still works on the old shape, and a running tool an
        // officer can use beats a clean exit.
        console.error("[startup] migrations failed:", (err as Error).message);
      });
  }
  return ready;
}
