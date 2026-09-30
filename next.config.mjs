import { readFileSync } from "node:fs";

// The version, read once at build time and baked into the client bundle.
//
// There was no way to tell which version was running from inside the app. That
// sounds cosmetic until an update appears not to have worked: "it looks the same"
// and "it IS the same" are indistinguishable without this, and the honest answer
// took a look at the release assets.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_APP_VERSION: version },
  // Produce a self-contained server bundle (.next/standalone) that Electron can
  // launch as a child process without the full node_modules tree. See
  // electron/main.js and scripts/assemble-standalone.ts.
  output: "standalone",
  // Prisma ships a native query-engine binary that Next's file tracer must keep
  // beside the standalone server. Mark it external so it is not bundled/mangled.
  // Native or dynamically-loaded packages that must stay outside the bundle and
  // sit beside the standalone server: Prisma's query engine, pdf.js and
  // tesseract.js (both loaded by dynamic import), and @napi-rs/canvas (a
  // prebuilt .node). scripts/assemble-standalone.ts copies each one in.
  serverExternalPackages: [
    "@prisma/client",
    ".prisma/client",
    "pdfjs-dist",
    "tesseract.js",
    "tesseract.js-core",
    "@napi-rs/canvas",
  ],
};

export default nextConfig;
