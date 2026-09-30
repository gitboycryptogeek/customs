/**
 * Download the prebuilt database from the latest GitHub release.
 *
 * prisma/customs.db is a build output, not a committed file, so a fresh clone has
 * no database. Building one from the PDFs takes 5-10 minutes (111 scanned pages
 * of OCR); this pulls the one CI already built, which takes seconds.
 *
 *   npm run db:fetch              # latest release
 *   npm run db:fetch -- v0.2.0    # a specific tag
 *
 * `npm run db:build` is the offline equivalent, and the only option if you have
 * changed a loader — a released database predates your change.
 */
import { createWriteStream, existsSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve, dirname } from "node:path";

const REPO = process.env.GITHUB_REPO || "gitboycryptogeek/customs";
const ASSET = "customs.db";
const TARGET = resolve("prisma/customs.db");
const PART = TARGET + ".part";

const tag = process.argv.slice(2).find((a) => !a.startsWith("-"));

if (existsSync(TARGET) && !process.argv.includes("--force")) {
  console.error(`${TARGET} already exists.`);
  console.error("Overwriting discards any documents you added through the app.");
  console.error("Re-run with --force if that is what you want.");
  process.exit(1);
}

async function main() {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "customs-db-fetch",
  };
  // Optional — only raises the rate limit. The repo is public.
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const url = tag
    ? `https://api.github.com/repos/${REPO}/releases/tags/${tag}`
    : `https://api.github.com/repos/${REPO}/releases/latest`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
  const release = (await res.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string; size: number }[];
  };

  const asset = release.assets.find((a) => a.name === ASSET);
  if (!asset) {
    console.error(`Release ${release.tag_name} has no ${ASSET} asset.`);
    console.error("Releases before v0.2.0 shipped the database inside the repo instead.");
    console.error("Build it locally:  npm run db:build");
    process.exit(1);
  }

  console.log(`Downloading ${ASSET} from ${release.tag_name} (${Math.round(asset.size / 1048576)} MB)...`);
  const dl = await fetch(asset.browser_download_url, { headers: { "user-agent": "customs-db-fetch" } });
  if (!dl.ok || !dl.body) throw new Error(`download failed: ${dl.status}`);

  mkdirSync(dirname(TARGET), { recursive: true });
  rmSync(PART, { force: true });
  // Via a .part file so an interrupted download cannot leave a truncated
  // database sitting where the app expects a working one.
  await pipeline(Readable.fromWeb(dl.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(PART));
  rmSync(TARGET, { force: true });
  renameSync(PART, TARGET);

  console.log(`Database ready: ${TARGET}`);
}

main().catch((e) => {
  rmSync(PART, { force: true });
  console.error(e.message);
  console.error("Build it from the PDFs instead:  npm run db:build");
  process.exit(1);
});
