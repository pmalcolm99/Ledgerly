import "server-only";

import { adminRouter } from "./routers/admin";
import { authRouter } from "./routers/auth";
import { categoriesRouter } from "./routers/categories";
import { membersRouter } from "./routers/members";
import { projectsRouter } from "./routers/projects";
import { receiptItemsRouter } from "./routers/receiptItems";
import { receiptsRouter } from "./routers/receipts";
import { usersRouter } from "./routers/users";
import { router } from "./trpc";

/**
 * Root router composition. Feature routers are added phase by phase
 * (Phase 4 projects/members; Phase 5 receipts delete — upload and image
 * serving are Route Handlers, not tRPC; Phase 6 admin AI usage; Phase 7
 * everything the UI reads and writes — receipt list/get/update, line items,
 * categories, the user directory, project rollups, the admin overview;
 * Phase 8 export — still to come).
 */
export const appRouter = router({
  auth: authRouter,
  admin: adminRouter,
  projects: projectsRouter,
  members: membersRouter,
  receipts: receiptsRouter,
  receiptItems: receiptItemsRouter,
  categories: categoriesRouter,
  users: usersRouter,
});

export type AppRouter = typeof appRouter;
