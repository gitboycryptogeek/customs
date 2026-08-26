/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Produce a self-contained server bundle (.next/standalone) that Electron can
  // launch as a child process without the full node_modules tree. See
  // electron/main.js and scripts/assemble-standalone.ts.
  output: "standalone",
  // Prisma ships a native query-engine binary that Next's file tracer must keep
  // beside the standalone server. Mark it external so it is not bundled/mangled.
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
};

export default nextConfig;
