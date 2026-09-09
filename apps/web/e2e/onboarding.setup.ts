import { expect, test as setup } from "@playwright/test";

/**
 * apps/web/e2e/onboarding.setup.ts — runs once, before every other spec.
 *
 * `DEV_AUTH_BYPASS` provides a fixed identity, and that identity is
 * JIT-provisioned with no first or last name — so it is authenticated but NOT
 * onboarded, and `(app)/layout.tsx` correctly redirects every route to
 * /welcome until the name is filled in (D-28).
 *
 * That redirect is the onboarding gate working exactly as designed, so this
 * file completes onboarding rather than working around it — which also makes
 * it the test for the brief's §1 requirement that onboarding blocks all other
 * routes until complete, and is shown once.
 */
setup("onboarding blocks other routes, then completes", async ({ page }) => {
  await page.goto("/");

  // Either we are already onboarded from a previous run, or we were sent to
  // /welcome. Both are correct; only the second needs doing.
  if (page.url().includes("/welcome")) {
    await expect(page.getByRole("heading", { name: "Welcome to Ledgerly" })).toBeVisible();

    // No nested forms on the very first screen either.
    expect(await page.evaluate(() => document.querySelectorAll("form form").length)).toBe(0);

    await page.getByLabel("First name").fill("Dev");
    await page.getByLabel("Last name").fill("User");
    await page.getByRole("button", { name: "Continue" }).click();
  }

  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible({ timeout: 20_000 });

  // Shown ONCE (brief §1): returning to /welcome now bounces straight back.
  //
  // The goto is expected to be "interrupted by another navigation" — that
  // interruption is the redirect, and Playwright reports it as a goto failure
  // rather than a result, so the outcome is asserted on the resulting URL
  // instead of on goto's return.
  await page.goto("/welcome", { waitUntil: "commit" }).catch(() => {});
  await page.waitForURL((url) => !url.pathname.startsWith("/welcome"), {
    timeout: 15_000,
    waitUntil: "commit",
  });
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
});

/**
 * Compiles every route once before the assertions run.
 *
 * These tests run against `next dev`, which compiles a route on its FIRST
 * request — routinely 1-2 seconds, and occasionally a "Fast Refresh had to
 * perform a full reload" that yanks the page out from under a click. Paying
 * that cost here, outside any assertion window, is what makes the suite
 * deterministic.
 *
 * A production build would avoid this, but cannot be used: `DEV_AUTH_BYPASS`
 * is refused at startup under NODE_ENV=production (D-05), which is exactly the
 * guarantee that makes the bypass safe to have at all.
 */
setup("warm every route so dev-mode compilation is not inside a test", async ({ page }) => {
  for (const path of ["/", "/review", "/settings/categories", "/admin"]) {
    await page.goto(path, { waitUntil: "commit" }).catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
  }
  // Requested directly rather than through a page: they are route handlers,
  // and the first hit compiles them too.
  for (const path of ["/manifest.webmanifest", "/api/trpc/categories.list?batch=1"]) {
    await page.request.get(path).catch(() => {});
  }
});

/**
 * Creates the one project the assertion specs navigate into.
 *
 * Done here, once, rather than lazily inside the specs: two specs each
 * creating-or-reusing a project race each other through the same modal and the
 * same `projects_owner_name_live_key` unique index, which turns an unrelated
 * layout assertion into a flaky CONFLICT. Setup owns the fixture; the specs
 * only navigate.
 */
setup("create the fixture project", async ({ page }) => {
  await page.goto("/", { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible({ timeout: 20_000 });

  const link = page.locator('a[href^="/projects/"]').first();

  // Wait for the list query to resolve before touching anything. The "New
  // project" button is server-rendered, so it looks clickable well before
  // React has attached its handler — a click in that window is swallowed
  // silently and the modal never opens.
  await expect(link.or(page.getByText("No projects yet"))).toBeVisible({ timeout: 20_000 });
  if ((await link.count()) > 0) return;

  await page
    .getByRole("button", { name: /new project|create your first project/i })
    .first()
    .click();
  await expect(page.getByLabel("Name")).toBeVisible();
  await page.getByLabel("Name").fill("E2E Project");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(link).toBeVisible({ timeout: 20_000 });
});
