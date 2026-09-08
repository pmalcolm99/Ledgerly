import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { categories } from "./schema/index";
import { db } from "./testHarness";

// Proves the default per-test transaction-rollback wrapper (task 2.12,
// D-18): a test that inserts leaves the database unchanged after the run.
// This only works if the two `it` blocks below run as genuinely separate
// tests under the same wrapper — see packages/db/vitest.config.ts, which
// wires up test/setup.ts as this package's setupFile.

const MARKER_SLUG = "harness-proof-marker";

describe("testHarness rollback wrapper", () => {
  it("allows an insert to succeed inside the test", async () => {
    await db().insert(categories).values({ name: "Harness Proof", slug: MARKER_SLUG });

    const rows = await db().select().from(categories).where(eq(categories.slug, MARKER_SLUG));
    expect(rows).toHaveLength(1);
  });

  it("does not see the previous test's insert — it was rolled back", async () => {
    const rows = await db().select().from(categories).where(eq(categories.slug, MARKER_SLUG));
    expect(rows).toHaveLength(0);
  });
});
