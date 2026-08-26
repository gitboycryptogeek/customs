/**
 * Post-build step: make `.next/standalone` fully self-contained so Electron can
 * run it as a child process with no other files.
 *
 * `next build` (with output: "standalone") emits a minimal server bundle but,
 * by design, does NOT copy:
 *   - `.next/static`  (the client JS/CSS) — must sit at `standalone/.next/static`
 *   - `public/`       (the served PDFs)   — must sit at `standalone/public`
 * and its dependency tracer is unreliable for Prisma's native query-engine
 * binaries, so we copy the generated Prisma client + engines in explicitly.
 *
 * Run automatically by `npm run app:build` after `next build`.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const standalone = join(root, ".next", "standalone");

function copy(from: string, to: string, label: string) {
  if (!existsSync(from)) throw new Error(`Expected ${label} at ${from} — did "next build" run?`);
  mkdirSync(join(to, ".."), { recursive: true });
  cpSync(from, to, { recursive: true, dereference: true });
  console.log(`  ✓ ${label}`);
}

function main() {
  if (!existsSync(standalone)) {
    throw new Error('.next/standalone not found — run "next build" with output:"standalone" first.');
  }
  console.log("Assembling standalone bundle:");

  // 1. Client assets and public files Next leaves out of standalone.
  copy(join(root, ".next", "static"), join(standalone, ".next", "static"), ".next/static");
  copy(join(root, "public"), join(standalone, "public"), "public (PDFs)");

  // 2. Prisma generated client + native query engines (all bundled OS targets).
  copy(join(root, "node_modules", ".prisma"), join(standalone, "node_modules", ".prisma"), ".prisma/client + engines");
  copy(join(root, "node_modules", "@prisma", "client"), join(standalone, "node_modules", "@prisma", "client"), "@prisma/client");

  console.log("Standalone bundle ready at .next/standalone");
}

main();
