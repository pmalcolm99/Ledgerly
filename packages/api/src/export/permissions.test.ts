import ExcelJS from "exceljs";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  mkTestUser,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import {
  auditLog,
  categories,
  projects,
  receiptItems,
  users as usersTable,
} from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";

import { appRouter } from "../root";
import type { Context } from "../trpc";
import { ExportError, startProjectExport } from "./index";
import { SHEET_LINE_ITEMS, SHEET_RECEIPTS } from "./workbook";
import { LINE_ITEM_COLUMNS } from "./rows";
import { drainStream, loadWorkbook, seedExportFixture } from "./fixture.test-helper";

/**
 * packages/api/src/export/permissions.test.ts — who may export, what gets
 * audited, and whether the export agrees with the list it was launched from.
 *
 * The authorization matrix mirrors `routers/phase7Permissions.test.ts`.
 * Export is gated at `scopedProjects(user, "read")` and nothing else: it is a
 * read, and the matrix in `docs/SCHEMA.md` gives every membership level
 * "View". The interesting cells are therefore the negative one (a
 * non-member) and the two that are easy to get wrong (an archived project,
 * which `read` deliberately includes, and the instance owner, who
 * short-circuits the scope entirely and must still be audited).
 */

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
});

afterAll(async () => {
  await getCleanPool().end();
});

const NOW = new Date("2026-09-09T14:22:31.000Z");

function receiptIds(workbook: ExcelJS.Workbook): string[] {
  const sheet = workbook.getWorksheet(SHEET_RECEIPTS);
  if (!sheet) throw new Error("receipts sheet missing");
  const ids: string[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    ids.push(String((row.values as unknown[])[1]));
  });
  return ids;
}

async function fixtureProject(name = "Kitchen Remodel") {
  const { project, users } = await createTestProjectWithMembers(db, {
    ownerKey: "owner1",
    members: [
      { key: "reader", permission: "read" },
      { key: "adder", permission: "read_add" },
      { key: "manager", permission: "full" },
    ],
    name,
  });
  const owner = users.owner1;
  if (!owner) throw new Error("owner missing");
  const seeded = await seedExportFixture(db, project.id, owner.id, { count: 6 });
  return { project, users, owner, seeded };
}

describe("export authorization", () => {
  for (const key of ["owner1", "reader", "adder", "manager"] as const) {
    it(`a ${key} may export`, async () => {
      const { project, users } = await fixtureProject();
      const actor = users[key];
      if (!actor) throw new Error(`${key} missing`);

      const started = await startProjectExport({
        db,
        user: actor as unknown as AuthUser,
        projectId: project.id,
        format: "xlsx",
        filters: {},
        now: NOW,
      });
      expect(started.receiptCount).toBe(6);
      expect(receiptIds(await loadWorkbook(started.stream))).toHaveLength(6);
    });
  }

  it("a non-member gets 404, not 403 — never an existence oracle", async () => {
    const { project } = await fixtureProject();
    const stranger = await mkTestUser(db, "stranger");

    await expect(
      startProjectExport({
        db,
        user: stranger as unknown as AuthUser,
        projectId: project.id,
        format: "xlsx",
        filters: {},
        now: NOW,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("a nonexistent project is indistinguishable from an unauthorized one", async () => {
    const stranger = await mkTestUser(db, "stranger");
    const error = await startProjectExport({
      db,
      user: stranger as unknown as AuthUser,
      projectId: "00000000-0000-0000-0000-000000000000",
      format: "xlsx",
      filters: {},
      now: NOW,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExportError);
    expect((error as ExportError).status).toBe(404);
    expect((error as ExportError).message).toBe("Not found.");
  });

  /**
   * `scope.ts` excludes archived projects only at the `add` level. Export is
   * a read, and an archived project — a finished job — is exactly the one
   * someone exports for their taxes.
   */
  it("an archived project still exports", async () => {
    const { project, users } = await fixtureProject();
    await db
      .update(projects)
      .set({ status: "archived", archivedAt: new Date() })
      .where(eq(projects.id, project.id));

    const started = await startProjectExport({
      db,
      user: users.reader as unknown as AuthUser,
      projectId: project.id,
      format: "xlsx",
      filters: {},
      now: NOW,
    });
    expect(started.receiptCount).toBe(6);
    await drainStream(started.stream);
  });

  it("the instance owner may export a project they do not belong to", async () => {
    const { project } = await fixtureProject();
    const instanceOwner = await mkTestUser(db, "instance", "owner");

    const started = await startProjectExport({
      db,
      user: instanceOwner as unknown as AuthUser,
      projectId: project.id,
      format: "xlsx",
      filters: {},
      now: NOW,
    });
    expect(started.receiptCount).toBe(6);
    await drainStream(started.stream);
  });
});

describe("export audit", () => {
  it("writes exactly one export.generated row, with the filter in metadata", async () => {
    const { project, users } = await fixtureProject();
    const reader = users.reader;
    if (!reader) throw new Error("reader missing");

    await drainStream(
      (
        await startProjectExport({
          db,
          user: reader as unknown as AuthUser,
          projectId: project.id,
          format: "csv",
          filters: { from: "2026-03-01", to: "2026-03-31", needsReview: true },
          now: NOW,
        })
      ).stream,
    );

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "export.generated"), eq(auditLog.entityId, project.id)));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorUserId).toBe(reader.id);
    expect(rows[0]?.entityType).toBe("project");
    expect(rows[0]?.metadata).toEqual({
      format: "csv",
      filters: { from: "2026-03-01", to: "2026-03-31", needsReview: true },
      via: "api.projects.export",
    });
  });

  it("carries no email or personal name into the audit row", async () => {
    const { project, users } = await fixtureProject();
    await drainStream(
      (
        await startProjectExport({
          db,
          user: users.reader as unknown as AuthUser,
          projectId: project.id,
          format: "xlsx",
          filters: {},
          now: NOW,
        })
      ).stream,
    );

    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "export.generated"));
    const serialised = JSON.stringify(row?.metadata);
    expect(serialised).not.toContain("@");
  });

  it("adds owner_override.performed when the instance owner exports another's project", async () => {
    const { project } = await fixtureProject();
    const instanceOwner = await mkTestUser(db, "instance", "owner");

    await drainStream(
      (
        await startProjectExport({
          db,
          user: instanceOwner as unknown as AuthUser,
          projectId: project.id,
          format: "xlsx",
          filters: {},
          now: NOW,
        })
      ).stream,
    );

    const overrides = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "owner_override.performed"));
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.metadata).toMatchObject({
      underlyingAction: "export.generated",
      via: "api.projects.export",
    });
  });

  it("writes no override row when a project's own owner exports it", async () => {
    const { project, owner } = await fixtureProject();
    await drainStream(
      (
        await startProjectExport({
          db,
          user: owner as unknown as AuthUser,
          projectId: project.id,
          format: "xlsx",
          filters: {},
          now: NOW,
        })
      ).stream,
    );

    const overrides = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "owner_override.performed"));
    expect(overrides).toHaveLength(0);
  });
});

describe("export data leakage", () => {
  /**
   * Review finding M-3. `resolveFilterLabels` deliberately strips the email
   * from the single header line, on the grounds that this file gets emailed
   * to an accountant. `uploaderName` used to apply `displayNameOf` WITH the
   * email — and `display_name` is nullable for everyone, `first/last` until
   * onboarding — so one export could carry a colleague's address in thousands
   * of cells while the header refused to carry it once. One policy, both
   * places.
   */
  it("never writes an uploader's email address into the workbook", async () => {
    const { project, users: created } = await createTestProjectWithMembers(db, {
      ownerKey: "owner1",
      members: [],
    });
    const owner = created.owner1;
    if (!owner) throw new Error("owner missing");
    await seedExportFixture(db, project.id, owner.id, { count: 4 });

    // The worst case: a user with nothing but an email to fall back on.
    await db
      .update(usersTable)
      .set({ displayName: null, firstName: null, lastName: null })
      .where(eq(usersTable.id, owner.id));

    const started = await startProjectExport({
      db,
      user: { ...owner, displayName: null, firstName: null, lastName: null } as unknown as AuthUser,
      projectId: project.id,
      format: "csv",
      filters: { uploadedBy: owner.id },
      now: NOW,
    });

    const chunks: Buffer[] = [];
    for await (const chunk of started.stream) chunks.push(chunk as Buffer);
    const csv = Buffer.concat(chunks).toString("utf8");

    expect(csv).not.toContain(owner.email);
    expect(csv).not.toContain("@example.com");
    expect(csv).toContain("Unknown user");
  });
});

describe("export filter parity with receipts.list", () => {
  /**
   * The export must select the same receipts the user was looking at. This
   * asserts it against `receipts.list` itself rather than against a
   * re-derived expectation, so a change to one that is not made to the other
   * fails here rather than in someone's accountant's inbox.
   */
  it("selects the same receipt set as the list, for the same filters", async () => {
    const { project, owner } = await fixtureProject();
    const user = owner as unknown as AuthUser;
    const ctx: Context = { db, user };
    const caller = appRouter.createCaller(ctx);

    const filters = { from: "2026-03-05", to: "2026-03-15" };

    const listed = await caller.receipts.list({ projectId: project.id, ...filters, limit: 100 });
    const started = await startProjectExport({
      db,
      user,
      projectId: project.id,
      format: "xlsx",
      filters,
      now: NOW,
    });

    const exported = receiptIds(await loadWorkbook(started.stream));
    expect(exported.length).toBeGreaterThan(0);
    expect([...exported].sort()).toEqual([...listed.items.map((r) => r.id)].sort());
  });

  /**
   * A category filter selects RECEIPTS (the correlated EXISTS `list` uses),
   * and then every item of each selected receipt is written — including the
   * ones in other categories. That is what keeps the two sheets reconciling:
   * dropping the non-matching items would leave sheet 2's totals unbacked by
   * sheet 1.
   */
  it("a category filter selects receipts, and keeps all of their items", async () => {
    const { project, owner } = await fixtureProject();
    const user = owner as unknown as AuthUser;

    const [category] = await db
      .select({ id: categories.id })
      .from(categories)
      .innerJoin(receiptItems, eq(receiptItems.categoryId, categories.id))
      .limit(1);
    if (!category) throw new Error("no categorised item in the fixture");

    const listed = await appRouter
      .createCaller({ db, user })
      .receipts.list({ projectId: project.id, categoryId: category.id, limit: 100 });

    const started = await startProjectExport({
      db,
      user,
      projectId: project.id,
      format: "xlsx",
      filters: { categoryId: category.id },
      now: NOW,
    });
    const workbook = await loadWorkbook(started.stream);

    expect([...receiptIds(workbook)].sort()).toEqual([...listed.items.map((r) => r.id)].sort());

    // Every exported receipt's FULL item list is present, not just the
    // matching ones — so at least one row carries a different category.
    const sheet = workbook.getWorksheet(SHEET_LINE_ITEMS);
    if (!sheet) throw new Error("line items sheet missing");
    const CATEGORY = LINE_ITEM_COLUMNS.findIndex((c) => c.header === "category");
    const seen = new Set<string>();
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= 5) return;
      seen.add(String((row.values as unknown[])[CATEGORY + 1] ?? "(blank)"));
    });
    expect(seen.size).toBeGreaterThan(1);
  });
});
