// Download page for the Customs Compliance desktop app.
//
// Installers live on GitHub Releases — a Heroku dyno cannot hold a 200MB
// artifact on an ephemeral filesystem inside a 500MB slug. This serves the page
// and redirects downloads to the release assets, so there is exactly one copy of
// each installer and one place a version number comes from.

const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { shapeRelease } = require("./release");

const app = express();
const PORT = process.env.PORT || 3000;
const REPO = process.env.GITHUB_REPO || "gitboycryptogeek/customs";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);

app.disable("x-powered-by");

// ---------------------------------------------------------------------------
// Release lookup
// ---------------------------------------------------------------------------

/** @type {{ at: number, data: object } | null} */
let cache = null;
/** Deduplicates concurrent misses so a cold cache can't fan out into N API calls. */
let inFlight = null;

async function fetchLatest() {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "customs-compliance-site",
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return shapeRelease(await res.json(), REPO);
}

/**
 * Latest release, cached.
 *
 * On a GitHub failure an expired cache is served rather than an error: the page
 * being a few minutes stale is much better than a download page that is down.
 */
async function getLatest() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  if (inFlight) return inFlight;

  inFlight = fetchLatest()
    .then((data) => {
      cache = { at: Date.now(), data };
      return data;
    })
    .catch((err) => {
      console.error("[latest] lookup failed:", err.message);
      if (cache) return cache.data; // stale, but real
      return {
        version: null,
        publishedAt: null,
        notes: "",
        releaseUrl: `https://github.com/${REPO}/releases`,
        assets: {},
        unavailable: true,
      };
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

app.get("/api/latest", async (_req, res) => {
  const latest = await getLatest();
  res.set("cache-control", "public, max-age=60");
  res.json(latest);
});

/** Stable download links, so a shared URL keeps working across releases. */
app.get("/download/:os", async (req, res) => {
  const latest = await getLatest();
  const key = { win: "windows", windows: "windows", mac: "macos", macos: "macos", linux: "linux", deb: "linux-deb" }[
    req.params.os.toLowerCase()
  ];
  const asset = key && latest.assets[key];
  if (!asset) return res.redirect(302, latest.releaseUrl);
  res.redirect(302, asset.url);
});

const TEMPLATE = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");

app.get("/", async (_req, res) => {
  const latest = await getLatest();
  // Injected rather than fetched so the page renders complete on first paint —
  // and still says something useful with JavaScript switched off.
  const html = TEMPLATE.replace(
    "/*__LATEST__*/null",
    JSON.stringify(latest).replace(/</g, "\u003c")
  );
  res.set("cache-control", "public, max-age=60").type("html").send(html);
});

app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

app.listen(PORT, () => console.log(`Download page listening on :${PORT} (repo ${REPO})`));
