// Locating the files pdf.js needs on disk.
//
// pdf.js needs two things at runtime: its worker bundle and its standard font
// data. Both are found by looking for the package directory rather than by
// asking Node to resolve a module specifier, because inside the Next build
// neither half of that works:
//
//   - webpack statically reads the argument of any resolve call and fails the
//     build on the ESM worker with "ESM packages need to be imported";
//   - it also substitutes its own `require`/`createRequire`, so a resolve that
//     succeeds under plain Node fails inside the bundled server.
//
// Walking the filesystem has neither problem, behaves the same under `tsx`,
// `next dev`, `next start` and the packaged app, and fails with a message that
// says where it looked.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE = "pdfjs-dist";

/**
 * Directories that might contain a node_modules holding the package.
 *
 * The working directory is the one that matters: `npm run dev` and
 * `npm run start` run from the project root, and the packaged desktop app runs
 * the standalone server with its cwd inside .next/standalone — where
 * scripts/assemble-standalone.ts has copied pdfjs-dist for exactly this reason.
 */
function searchRoots(): string[] {
  const roots: string[] = [];
  if (process.env.PDFJS_ROOT) roots.push(process.env.PDFJS_ROOT);

  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    roots.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

let cachedDir: string | null = null;

/** Absolute path to the installed pdfjs-dist directory. */
export function packageDir(): string {
  if (cachedDir) return cachedDir;

  const tried: string[] = [];
  for (const root of searchRoots()) {
    const candidate = join(root, "node_modules", PACKAGE);
    if (existsSync(join(candidate, "package.json"))) {
      cachedDir = candidate;
      return cachedDir;
    }
    tried.push(candidate);
  }

  throw new Error(
    `${PACKAGE} could not be found (looked in: ${tried.join(", ")}). ` +
      "It must sit beside the server — see scripts/assemble-standalone.ts."
  );
}

/** Absolute path to a file inside the package, e.g. "legacy/build/pdf.worker.mjs". */
export function packageFile(...segments: string[]): string {
  return join(packageDir(), ...segments);
}

/**
 * The pdf.js worker, as a file:// URL.
 *
 * pdf.js loads it through the ESM loader, which rejects a bare Windows path
 * like "C:\..." as an unknown URL scheme — so it has to be a URL, not a path.
 */
export function workerSrc(): string {
  return pathToFileURL(packageFile("legacy", "build", "pdf.worker.mjs")).href;
}

/** Directory holding pdf.js's standard font metrics. The trailing slash matters. */
export function standardFontDataUrl(): string {
  return `${packageFile("standard_fonts")}/`;
}
