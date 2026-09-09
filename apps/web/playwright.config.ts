import { defineConfig, devices } from "@playwright/test";

/** Mirrors global-setup.ts's derivation so the server and the setup agree on
 *  which database is being used. */
function e2eDatabaseUrl(base: string | undefined): string {
  if (!base) return "";
  const url = new URL(base);
  url.pathname = "/ledgerly_e2e";
  return url.toString();
}

/**
 * apps/web/playwright.config.ts — the browser-rendered checks (tasks 7.11,
 * 7.12).
 *
 * WEBKIT ONLY, and that is the whole point. `docs/reference/FORKD_LESSONS.md`
 * records three bugs that appeared *only* on iOS — nested forms silently
 * corrected by the parser, z-indexes escaping a stacking context, and 100vh
 * overflowing under the collapsing toolbar — and none of them were caught by
 * unit tests or by Chrome's device emulator. WebKit is the engine those bugs
 * live in. Running Chromium here would cost CI time and prove the wrong thing.
 *
 * The viewport is a 390px iPhone, because that is the device this app is for.
 *
 * NOTE ON D-19 / ARCHITECTURE.md §38: those record "Ledgerly has no
 * Playwright", written about the RUNTIME image — Forkd's pain was
 * `playwright-core` breaking Next's standalone file tracing. This is a
 * devDependency used by CI and never traced into the container, so the hazard
 * that decision was avoiding does not apply. Recorded as D-34.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  // Generous on purpose. These run against `next dev`, where a route compiles
  // on first request and this app hydrates ~5,400 modules in WebKit — a first
  // paint plus hydration can take well over 20 seconds on a cold route. The
  // per-test budget has to exceed the individual waits inside a test, or the
  // test dies first and reports the inner wait as the failure, which is what
  // made this suite look flaky rather than slow.
  timeout: 120_000,
  expect: { timeout: 30_000 },

  // The dedicated `ledgerly_e2e` database is created by `e2e/prepare-db.ts`,
  // run as a separate step before this config is loaded — NOT as globalSetup,
  // which Playwright runs after starting webServer, too late to help.

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3111",
    trace: "retain-on-failure",
  },

  projects: [
    {
      // Runs first. The dev-bypass identity is authenticated but not
      // onboarded, so every route redirects to /welcome until this completes
      // — which is the onboarding gate working, not a fixture workaround.
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      use: { ...devices["iPhone 14"] },
    },
    {
      name: "mobile-webkit",
      use: { ...devices["iPhone 14"] },
      dependencies: ["setup"],
    },
  ],

  webServer: {
    // `next dev`, not a production build: the dev bypass only works outside
    // NODE_ENV=production, and Next's standalone server forces production
    // internally regardless of what is injected (docs/STATE.md's Phase 2
    // note).
    command: "pnpm exec next dev --port 3111 --hostname 127.0.0.1",
    url: "http://127.0.0.1:3111/api/v1/health",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NODE_ENV: "development",
      // Access is bypassed with the fixed DEV_IDENTITY, which is
      // JIT-provisioned and becomes the local instance owner. D-05 makes this
      // impossible in production: the process refuses to boot.
      DEV_AUTH_BYPASS: "true",
      CF_ACCESS_ENABLED: "false",
      // The dedicated e2e database global-setup.ts just created. Never the
      // real one, and never the unit suite's either (D-18).
      DATABASE_URL: e2eDatabaseUrl(process.env.TEST_DATABASE_URL),
      REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6380/1",
      MASTER_KEY: process.env.MASTER_KEY ?? "",
      ANTHROPIC_API_KEY: "e2e-placeholder-key",
      UPLOADS_DIR: process.env.E2E_UPLOADS_DIR ?? "/tmp/ledgerly-e2e-uploads",
      APP_PORT: "3111",
    },
  },
});
