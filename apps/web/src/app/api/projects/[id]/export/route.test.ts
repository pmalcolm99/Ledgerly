import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  mkTestUser,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { receiptItems, receipts, users } from "@ledgerly/db/schema";
import { eq } from "drizzle-orm";

/**
 * apps/web/src/app/api/projects/[id]/export/route.test.ts — the HTTP surface
 * of Phase 8: status codes, headers, and the filename.
 *
 * The workbook's CONTENTS are covered in `packages/api/src/export/*.test.ts`
 * against the builder directly. What can only be tested here is the part
 * that is HTTP: that no identity is a 403 and an unauthorized project is a
 * 404 (never the other way round), that a bad parameter is a 400 decided
 * before any lookup, and that the response carries the headers a browser
 * needs to save the file rather than render it.
 *
 * `getDb` and `verifyAccessJwt` are mocked exactly as in
 * ../../../images/[...key]/route.test.ts — see that file's header for why.
 */

let db: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("@ledgerly/db/client", () => ({
  getDb: () => db,
  getPool: () => {
    throw new Error("getPool() should not be called in this test suite");
  },
}));

vi.mock("@ledgerly/auth/cloudflareAccess", () => ({
  verifyAccessJwt: vi.fn(async (token: string | null) => {
    if (!token) return { ok: false, reason: "missing_token" };
    return {
      ok: true,
      identity: {
        sub: token,
        email: `${token}@example.com`,
        name: "Test User",
        issuedAt: 0,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    };
  }),
  currentAccessConfig: vi.fn(() => ({ aud: "test-aud", teamDomain: "test.cloudflareaccess.com" })),
}));

const { handleExportGet } = await import("./handler");

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
});

afterAll(async () => {
  await getCleanPool().end();
});

function requestWith(sub: string | null, search = ""): Request {
  const headers = sub ? new Headers({ "cf-access-jwt-assertion": sub }) : new Headers();
  return new Request(`http://localhost/api/projects/x/export${search}`, { headers });
}

/** Two receipts with one item each, enough for a real workbook. */
async function seedSmall(projectId: string, uploadedBy: string): Promise<void> {
  for (let index = 0; index < 2; index += 1) {
    const [row] = await db
      .insert(receipts)
      .values({
        projectId,
        uploadedBy,
        merchantName: `Merchant ${index}`,
        transactionDate: `2026-03-0${index + 1}`,
        subtotal: "10.00",
        salesTax: "1.00",
        total: "11.00",
        extractionStatus: "ok",
      })
      .returning({ id: receipts.id });
    if (!row) throw new Error("seed failed");
    await db.insert(receiptItems).values({
      receiptId: row.id,
      lineNo: 1,
      description: `Item ${index}`,
      quantity: "1.000",
      unitPrice: "10.00",
      lineTotal: "10.00",
    });
  }
}

async function fixture(name = "Kitchen Remodel") {
  const { project, users: created } = await createTestProjectWithMembers(db, {
    ownerKey: "owner1",
    members: [],
    name,
  });
  const owner = created.owner1;
  if (!owner) throw new Error("owner missing");
  await seedSmall(project.id, owner.id);
  return { project, owner };
}

describe("GET /api/projects/[id]/export", () => {
  it("returns 403 with no identity at all", async () => {
    const { project } = await fixture();
    const response = await handleExportGet(requestWith(null), project.id, { db });
    expect(response.status).toBe(403);
  });

  it("returns 404, not 403, for a project the caller cannot see", async () => {
    const { project } = await fixture();
    await mkTestUser(db, "stranger");

    const response = await handleExportGet(requestWith("sub-stranger"), project.id, { db });
    expect(response.status).toBe(404);
  });

  it("returns byte-identical 404s for a nonexistent project and another user's real one", async () => {
    const { project } = await fixture();
    await mkTestUser(db, "stranger");

    const forReal = await handleExportGet(requestWith("sub-stranger"), project.id, { db });
    const forFake = await handleExportGet(
      requestWith("sub-stranger"),
      "99999999-9999-4999-8999-999999999999",
      { db },
    );

    expect(forReal.status).toBe(forFake.status);
    expect(await forReal.text()).toBe(await forFake.text());
  });

  it("returns 404 for an authenticated but un-onboarded user", async () => {
    const { project } = await fixture();
    const stranger = await mkTestUser(db, "stranger");
    await db
      .update(users)
      .set({ firstName: null, lastName: null, onboardedAt: null })
      .where(eq(users.id, stranger.id));

    const response = await handleExportGet(requestWith("sub-stranger"), project.id, { db });
    expect(response.status).toBe(404);
  });

  it("returns 400 for an unknown format", async () => {
    const { project } = await fixture();
    const response = await handleExportGet(requestWith("sub-owner1", "?format=pdf"), project.id, {
      db,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid export parameter: format.");
  });

  it("returns 400 for an inverted date range", async () => {
    const { project } = await fixture();
    const response = await handleExportGet(
      requestWith("sub-owner1", "?from=2026-06-01&to=2026-01-01"),
      project.id,
      { db },
    );
    expect(response.status).toBe(400);
  });

  /**
   * A malformed parameter is decided before any project lookup, so a 400 on
   * a project the caller cannot see would tell them the parameter was the
   * only problem — i.e. that the project exists. It must be a 400 for
   * everyone, or a 404 for everyone; this asserts it is consistently the
   * former and therefore leaks nothing about the project.
   */
  it("answers a malformed parameter identically whether or not the project is visible", async () => {
    const { project } = await fixture();
    await mkTestUser(db, "stranger");

    const asMember = await handleExportGet(requestWith("sub-owner1", "?format=pdf"), project.id, {
      db,
    });
    const asStranger = await handleExportGet(
      requestWith("sub-stranger", "?format=pdf"),
      project.id,
      { db },
    );

    expect(asStranger.status).toBe(asMember.status);
    expect(await asStranger.text()).toBe(await asMember.text());
  });

  it("serves an xlsx with the download headers a browser needs", async () => {
    const { project } = await fixture();
    const response = await handleExportGet(requestWith("sub-owner1"), project.id, { db });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="kitchen-remodel_\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    // A real zip, not an error page: the XLSX local file header magic.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
  });

  it("serves a csv with the csv content type and extension", async () => {
    const { project } = await fixture();
    const response = await handleExportGet(requestWith("sub-owner1", "?format=csv"), project.id, {
      db,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain(".csv");
    expect(await response.text()).toContain("line_total");
  });

  /**
   * Review finding M-2. An export is the heaviest read in the app and the
   * only one a client can park by opening the connection and not reading it,
   * so a per-user cap bounds how many can be in flight. Checked BEFORE the
   * project lookup, so a rate-limited caller learns nothing about whether the
   * project exists.
   */
  it("rate-limits exports per user, before any project lookup", async () => {
    const { project } = await fixture();

    let calls = 0;
    const denyingRedis = {
      eval: async () => {
        calls += 1;
        return 0; // the Lua script's "over limit" return
      },
    };

    const response = await handleExportGet(requestWith("sub-owner1"), project.id, {
      db,
      rateLimitRedis: denyingRedis,
    });

    expect(calls).toBe(1);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();

    // Same answer for a project the caller cannot see — no existence signal.
    await mkTestUser(db, "stranger");
    const asStranger = await handleExportGet(requestWith("sub-stranger"), project.id, {
      db,
      rateLimitRedis: denyingRedis,
    });
    expect(asStranger.status).toBe(429);
    expect(await asStranger.text()).toBe(await response.text());
  });

  it("exports normally when the limiter allows it", async () => {
    const { project } = await fixture();
    const allowingRedis = { eval: async () => 1 };

    const response = await handleExportGet(requestWith("sub-owner1"), project.id, {
      db,
      rateLimitRedis: allowingRedis,
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });

  /**
   * A project name is user input and reaches `Content-Disposition`. It cannot
   * carry a quote out of `slugify`, so the header stays well-formed and
   * single-valued no matter what the project is called.
   */
  it("cannot be made to inject a header through the project name", async () => {
    const { project } = await fixture('Report" ; filename="owned.exe');
    const response = await handleExportGet(requestWith("sub-owner1"), project.id, { db });

    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toMatch(/^attachment; filename="[a-z0-9-]+_\d{4}-\d{2}-\d{2}\.xlsx"$/);
    expect(disposition).not.toContain("owned.exe");
    await response.arrayBuffer();
  });
});
