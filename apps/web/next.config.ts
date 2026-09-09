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
  // exceljs joins them in Phase 8 for the same two reasons: it is CJS with
  // dynamic requires (it pulls archiver/unzipper), and it reaches apps/web
  // only through @ledgerly/api, so apps/web/package.json lists it as a
  // direct dependency too — see the tracing note above, which applies to it
  // verbatim.
  //
  // `nodemailer` (D-44) is deliberately NOT on this list, which makes it the
  // one exception to the pattern above — so the reasoning is recorded rather
  // than left to look like an oversight. This list is for packages webpack
  // must not bundle, and that is exactly what creates the resolution problem
  // the note above describes. nodemailer has no `__dirname`, no
  // `createRequire`, no `import.meta.url` and no dynamic requires in its
  // `dist/`, so webpack inlines it cleanly and there is no runtime
  // `require("nodemailer")` left to resolve — verified three ways against a
  // real standalone build: the SMTP transport appears inside the emitted
  // chunk, the containerised `receipt-email` worker starts and registers its
  // queue, and a receipt email was actually delivered through smtp2go from
  // that container.
  serverExternalPackages: ["sharp", "bullmq", "ioredis", "exceljs"],

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
