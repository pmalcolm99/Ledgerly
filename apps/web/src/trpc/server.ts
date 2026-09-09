import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { appRouter, createCallerFactory, createContext } from "@ledgerly/api";

/**
 * apps/web/src/trpc/server.ts — the RSC-side caller.
 *
 * Server Components call procedures in-process rather than over HTTP to
 * themselves. `welcome/page.tsx` already established this shape in Phase 3;
 * this just makes it reusable.
 *
 * `cache()`d per request so a page that reads two queries resolves identity
 * once (D-03), matching `server/identity.ts`.
 *
 * Deliberately NOT wired with `enqueueReceiptExtract`/`rateLimitRedis`: those
 * are supplied by the HTTP route handler, and no procedure a Server Component
 * calls needs them (they belong to `receipts.reextract`, which is a client
 * mutation). A Server Component calling it would get the documented warning
 * rather than a silent no-op.
 */
const createCaller = createCallerFactory(appRouter);

export const serverApi = cache(async () =>
  createCaller(await createContext({ headers: await headers() })),
);
