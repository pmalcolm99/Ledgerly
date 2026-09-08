import "server-only";

import { adminRouter } from "./routers/admin";
import { authRouter } from "./routers/auth";
import { router } from "./trpc";

/**
 * Root router composition. Feature routers are added phase by phase
 * (Phase 4 projects/members, Phase 6 admin AI usage, Phase 8 export).
 */
export const appRouter = router({
  auth: authRouter,
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;
