import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // These three are Node-native / dynamic-require-heavy and must not be
  // bundled by webpack — ARCHITECTURE.md §8.1. See src/instrumentation.ts
  // and packages/queue/src/worker.ts for how they become reachable in the
  // first place.
  //
  // Task 2.8 investigation note: listing them here is not sufficient on its
  // own for a pnpm-workspace standalone build. sharp and bullmq are only
  // *transitive* dependencies of apps/web (through @ledgerly/queue), so
  // pnpm never symlinks them into apps/web's own node_modules — only into
  // packages/queue's. Next's output file tracer discovers reachable
  // packages relative to each traced entrypoint's own node_modules chain,
  // so without a direct dependency it copies them to
  // .next/standalone/packages/queue/node_modules/, which is *not* on the
  // require() resolution path Node walks from the bundled code that
  // actually calls require("sharp")/require("bullmq") inside
  // .next/standalone/apps/web/. ioredis worked from the start only because
  // the health route (task 2.9) imports it directly. The fix is
  // apps/web/package.json listing sharp and bullmq as direct dependencies
  // too, purely so pnpm places the symlinks (and therefore the trace)
  // where the runtime require() calls can actually find them — verified by
  // running `node -e "require('./apps/web/node_modules/sharp')"` etc.
  // against a real `next build` output.
  serverExternalPackages: ["sharp", "bullmq", "ioredis"],

  async headers() {
    return [
      {
        // A service worker that is itself cached is a service worker you
        // cannot replace. Browsers already special-case /sw.js somewhat, but
        // an explicit no-cache is what guarantees a fixed worker actually
        // reaches an installed PWA rather than being shadowed by a stale copy
        // for up to 24 hours.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
