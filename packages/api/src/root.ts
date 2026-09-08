import "server-only";

import { adminRouter } from "./routers/admin";
import { authRouter } from "./routers/auth";
import { membersRouter } from "./routers/members";
import { projectsRouter } from "./routers/projects";
import { receiptsRouter } from "./routers/receipts";
import { router } from "./trpc";

/**
 * Root router composition. Feature routers are added phase by phase
 * (Phase 4 projects/members — done; Phase 5 receipts (delete only —
 * upload and image serving are Route Handlers, not tRPC); Phase 6 admin
 * AI usage, Phase 8 export — still to come).
 */
export const appRouter = router({
  auth: authRouter,
  admin: adminRouter,
  projects: projectsRouter,
  members: membersRouter,
  receipts: receiptsRouter,
});

export type AppRouter = typeof appRouter;
