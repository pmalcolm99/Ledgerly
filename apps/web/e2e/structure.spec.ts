import { expect, test } from "@playwright/test";

/**
 * apps/web/e2e/structure.spec.ts — tasks 7.11 and 7.12.
 *
 * Rendered in WebKit, asserted against the live DOM. String-matching the
 * markup is exactly what failed to catch Forkd's nested-form bug: the HTML
 * parser rewrites the structure, so the source can look correct while the DOM
 * is not.
 */

/**
 * Every navigation in this suite goes through here.
 *
 * `page.goto` defaults to waiting for the `load` event, which on this app in
 * dev never reliably fires: the service worker registers on load, Next holds
 * an HMR socket open, and React Query polls. A goto still waiting on `load`
 * when the next one starts is reported as "interrupted by another
 * navigation", which looks like a product bug and is not one.
 *
 * `commit` returns as soon as the response starts, and the real readiness
 * signal is the page's own heading being visible — which additionally proves
 * React hydrated, without which every click in these tests would be silently
 * swallowed.
 */
async function visit(
  page: import("@playwright/test").Page,
  path: string,
  heading: string,
): Promise<void> {
  await page.goto(path, { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 20_000 });
  await waitForStyles(page);
}

/**
 * Waits until the app's stylesheet has actually been applied.
 *
 * Without this, layout and computed-style assertions can run against an
 * unstyled document — which is not a subtle failure: WebKit's UA default for
 * an <input> is 11px, so the iOS-zoom check reads 11 instead of 16, and an
 * unstyled page overflows horizontally. Both look exactly like product bugs
 * and are not.
 *
 * `body` has an explicit `bg-background` in the layout, so a non-transparent
 * background is a reliable signal that Tailwind's output is live.
 */
async function waitForStyles(page: import("@playwright/test").Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const background = window.getComputedStyle(document.body).backgroundColor;
          return (
            background !== "" && background !== "rgba(0, 0, 0, 0)" && background !== "transparent"
          );
        }),
      { timeout: 20_000, message: "stylesheet never applied" },
    )
    .toBe(true);
}

/**
 * Waits until the project list has actually finished loading AND hydrated.
 *
 * Both halves matter. The "New project" button renders server-side, so it is
 * clickable-looking well before React has attached a handler to it — a click
 * in that window is silently swallowed and the modal never opens. Waiting for
 * a state that only appears after the client query resolves proves hydration
 * happened.
 */
async function waitForProjectList(page: import("@playwright/test").Page): Promise<void> {
  // The fixture project is created once in the setup project, so a card is
  // always expected here. Waiting for the card specifically — rather than
  // "a card OR the empty state" — means a genuinely broken list fails with a
  // useful message instead of silently taking the empty-state branch.
  await expect(page.locator('a[href^="/projects/"]').first()).toBeVisible({ timeout: 30_000 });
}

/**
 * Opens the fixture project by clicking its card.
 *
 * The project itself is created once, in the setup project — see
 * onboarding.setup.ts for why creation does not belong in an assertion spec.
 * Clicking rather than navigating by URL is both closer to what a user does
 * and immune to racing the list's own re-render.
 */
async function openProject(page: import("@playwright/test").Page): Promise<void> {
  await visit(page, "/", "Projects");
  await waitForProjectList(page);
  await page.locator('a[href^="/projects/"]').first().click();
  // "commit", for the same reason `visit` uses it: `load` does not
  // reliably fire with the service worker and the dev HMR socket open.
  await page.waitForURL(/\/projects\//, { waitUntil: "commit" });
  await waitForStyles(page);
}

test.describe("no nested forms (task 7.11)", () => {
  /**
   * HTML forbids nesting <form>. Browsers do not error — they silently drop
   * the inner tag and adopt its submit button into the OUTER form, which then
   * posts to the wrong endpoint. Forkd shipped that bug to production and its
   * unit tests passed throughout, because they string-matched the markup
   * rather than rendering it.
   */
  async function assertNoNestedForms(page: import("@playwright/test").Page, where: string) {
    const nested = await page.evaluate(() => document.querySelectorAll("form form").length);
    expect(nested, `nested <form> found on ${where}`).toBe(0);
  }

  test("project list, including the create-project modal", async ({ page }) => {
    await visit(page, "/", "Projects");
    await waitForProjectList(page);
    await assertNoNestedForms(page, "project list");

    // Opening the modal is enough — it must not create anything, or it races
    // the fixture. Its form must not be nested inside the page's own markup.
    await page
      .getByRole("button", { name: /new project|create your first project/i })
      .first()
      .click();
    await expect(page.getByLabel("Name")).toBeVisible();
    await assertNoNestedForms(page, "project list with the create modal open");
  });

  test("project dashboard", async ({ page }) => {
    await openProject(page);
    await expect(page.getByRole("button", { name: "Add receipts" })).toBeVisible();
    await assertNoNestedForms(page, "project dashboard");
  });

  test("category settings", async ({ page }) => {
    await visit(page, "/settings/categories", "Categories");
    await assertNoNestedForms(page, "category settings");
  });

  test("review queue", async ({ page }) => {
    await visit(page, "/review", "Review");
    await assertNoNestedForms(page, "review queue");
  });
});

test.describe("layout at a 390px viewport (task 7.12)", () => {
  test("modals render above everything", async ({ page }) => {
    await visit(page, "/", "Projects");
    await waitForProjectList(page);
    await page
      .getByRole("button", { name: /new project|create your first project/i })
      .first()
      .click();

    const nameInput = page.getByLabel("Name");
    await expect(nameInput).toBeVisible();

    // The real question is not "is it in the DOM" but "does the pointer reach
    // it" — a z-index escape leaves the field visible and unclickable, which
    // is exactly how Forkd's map-over-lightbox bug presented.
    const box = (await nameInput.boundingBox())!;
    const topmost = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x as number, y as number);
        return el ? el.tagName.toLowerCase() : null;
      },
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(topmost).toBe("input");

    await nameInput.fill("Reachable");
    await expect(nameInput).toHaveValue("Reachable");
  });

  // One test per page rather than a loop: Next's client-side router can still
  // be settling a transition when the next iteration calls goto, which
  // Playwright reports as "interrupted by another navigation". A test each
  // gives every page a fresh, quiet page object.
  const PAGES: Array<[string, string]> = [
    ["/", "Projects"],
    ["/review", "Review"],
    ["/settings/categories", "Categories"],
  ];

  for (const [path, heading] of PAGES) {
    test(`${path} does not scroll horizontally`, async ({ page }) => {
      await visit(page, path, heading);
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflows, `${path} scrolls horizontally at 390px`).toBe(false);
    });
  }

  test("inputs are at least 16px so iOS does not zoom on focus", async ({ page }) => {
    await visit(page, "/settings/categories", "Categories");
    const input = page.getByLabel("New category");
    await expect(input).toBeVisible();
    const fontSize = await input.evaluate((el) => parseFloat(window.getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(16);
  });
});

test.describe("PWA wiring (task 7.9)", () => {
  test("serves a valid manifest", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    expect(response.status()).toBe(200);
    const manifest = await response.json();
    expect(manifest.name).toBe("Ledgerly");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    const purposes = manifest.icons.map((icon: { purpose: string }) => icon.purpose);
    expect(purposes).toContain("maskable");
  });

  test("serves the service worker uncached, and the offline page", async ({ request }) => {
    const sw = await request.get("/sw.js");
    expect(sw.status()).toBe(200);
    // A cached service worker is one you cannot replace.
    expect(sw.headers()["cache-control"]).toContain("no-cache");

    const offline = await request.get("/offline.html");
    expect(offline.status()).toBe(200);
    expect(await offline.text()).toContain("You're offline");
  });

  test("every generated icon and splash image is reachable without a session", async ({
    request,
  }) => {
    // These are excluded from the Access matcher on purpose; if that exclusion
    // regresses, the install flow breaks in a way nothing else would catch.
    for (const path of [
      "/icon-192.png",
      "/icon-512.png",
      "/icon-maskable.png",
      "/apple-icon.png",
      "/splash/iphone-15-pro.png",
    ]) {
      const response = await request.get(path);
      expect(response.status(), `${path} was not served`).toBe(200);
    }
  });
});
