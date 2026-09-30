/**
 * Compatibility shim. The real implementation moved to lib/ingest/source.ts so
 * the CLI loaders and the in-app ingest pipeline share one append-only path.
 */
export { ensureSourceVersion, supersede, parseArgs } from "../../lib/ingest/source";
export type { SourceInput, EnsureResult } from "../../lib/ingest/source";
