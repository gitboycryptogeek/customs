// Turning a GitHub release into what the page needs.
//
// Split out from server.js so it can be tested without a network call — the
// unauthenticated GitHub API allows 60 requests an hour, which a test run should
// not be spending.

/** Which platform an asset filename belongs to, or null if it isn't an installer. */
function platformOf(name) {
  const n = String(name).toLowerCase();
  if (n.endsWith(".exe")) return "windows";
  if (n.endsWith(".dmg")) return "macos";
  if (n.endsWith(".appimage")) return "linux";
  if (n.endsWith(".deb")) return "linux-deb";
  // .yml / .blockmap are electron-updater's feed and delta files — real assets
  // on every release, but not things a person downloads.
  return null;
}

function bytesToSize(n) {
  if (!n || n < 0) return null;
  const mb = n / (1024 * 1024);
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** Shape a GitHub release payload into the page's contract. */
function shapeRelease(release, repo) {
  const assets = {};
  for (const a of release.assets || []) {
    const platform = platformOf(a.name);
    if (!platform) continue;
    // A release can carry several files per platform (x64 and arm64 dmgs, say).
    // Keep the first, which is the primary build electron-builder names plainly.
    if (assets[platform]) continue;
    assets[platform] = {
      name: a.name,
      url: a.browser_download_url,
      bytes: a.size,
      size: bytesToSize(a.size),
    };
  }

  return {
    version: String(release.tag_name || "").replace(/^v/, "") || null,
    publishedAt: release.published_at || null,
    notes: release.body || "",
    releaseUrl: release.html_url || `https://github.com/${repo}/releases`,
    assets,
  };
}

module.exports = { platformOf, bytesToSize, shapeRelease };
