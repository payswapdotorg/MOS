import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // DEP-005 / P0-SRC: the REAL MOS platform ships pre-bundled (mos-bundle/
  // mos.mjs + mos-bundle/migrations, rebuilt deterministically from THIS
  // repository's own backend src/ by `bun run build:bundle` — see
  // mos-build/build-bundle.mjs) and is loaded from disk at runtime by
  // src/lib/mos-runtime.ts. File tracing must therefore include the bundle +
  // MOS's own SQL migrations for EVERY route that loads it in-process: the
  // API bridge, the admin drain, and the sign-up orchestrator (DEP-007 — its
  // serverless function would otherwise boot without the bundle and fail
  // like the DEP-005b bridge did).
  outputFileTracingIncludes: {
    "/api/mos/[...path]": ["./mos-bundle/**"],
    "/api/mos-admin/drain": ["./mos-bundle/**"],
    "/api/mos-signup": ["./mos-bundle/**"],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
