// Verifies the release-shaping logic against a realistic electron-builder
// release payload, without spending a GitHub API call.
const assert = require("node:assert");
const { platformOf, bytesToSize, shapeRelease } = require("./release");

// The asset list electron-builder actually produces for this project.
const fixture = {
  tag_name: "v0.2.0",
  published_at: "2026-08-27T10:00:00Z",
  body: "Adds document ingestion and auto-update.",
  html_url: "https://github.com/gitboycryptogeek/customs/releases/tag/v0.2.0",
  assets: [
    { name: "Customs Compliance-Setup-0.2.0.exe", size: 198 * 1024 * 1024, browser_download_url: "https://x/setup.exe" },
    { name: "Customs Compliance-Setup-0.2.0.exe.blockmap", size: 210000, browser_download_url: "https://x/blockmap" },
    { name: "latest.yml", size: 400, browser_download_url: "https://x/latest.yml" },
    { name: "Customs Compliance-0.2.0.dmg", size: 205 * 1024 * 1024, browser_download_url: "https://x/app.dmg" },
    { name: "latest-mac.yml", size: 500, browser_download_url: "https://x/latest-mac.yml" },
    { name: "Customs Compliance-0.2.0.AppImage", size: 212 * 1024 * 1024, browser_download_url: "https://x/app.AppImage" },
    { name: "customs-compliance_0.2.0_amd64.deb", size: 190 * 1024 * 1024, browser_download_url: "https://x/app.deb" },
    { name: "latest-linux.yml", size: 500, browser_download_url: "https://x/latest-linux.yml" },
  ],
};

// Installers are recognised; updater metadata and deltas are not offered as downloads.
assert.strictEqual(platformOf("Setup.exe"), "windows");
assert.strictEqual(platformOf("App.DMG"), "macos");
assert.strictEqual(platformOf("App.AppImage"), "linux");
assert.strictEqual(platformOf("app_amd64.deb"), "linux-deb");
assert.strictEqual(platformOf("latest.yml"), null);
assert.strictEqual(platformOf("Setup.exe.blockmap"), null);

assert.strictEqual(bytesToSize(198 * 1024 * 1024), "198 MB");
assert.strictEqual(bytesToSize(0), null);

const shaped = shapeRelease(fixture, "gitboycryptogeek/customs");
assert.strictEqual(shaped.version, "0.2.0", "the v prefix is stripped");
assert.deepStrictEqual(Object.keys(shaped.assets).sort(), ["linux", "linux-deb", "macos", "windows"]);
assert.strictEqual(shaped.assets.windows.size, "198 MB");
assert.strictEqual(shaped.assets.windows.url, "https://x/setup.exe");
assert.strictEqual(shaped.notes, "Adds document ingestion and auto-update.");

// A release with nothing published yet must not throw.
const empty = shapeRelease({ tag_name: "", assets: [] }, "a/b");
assert.strictEqual(empty.version, null);
assert.deepStrictEqual(empty.assets, {});
assert.strictEqual(empty.releaseUrl, "https://github.com/a/b/releases");

console.log("release shaping: all assertions passed");
