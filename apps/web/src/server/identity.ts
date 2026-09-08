import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { resolveIdentityFromHeaders } from "@ledgerly/auth";
import type { AuthUser } from "@ledgerly/auth";

/**
 * apps/web/src/server/identity.ts — the RSC entry point to identity
 * (task 3.6).
 *
 * Wrapped in React `cache()` so a page that reads identity three times
 * issues ONE database query. That is FORKD_LESSONS.md's own fix for
 * "session resolution called multiple times per request", applied from the
 * start rather than after the incident, and it is what makes D-03's
 * no-session-table design affordable.
 *
 * The `next/headers` coupling lives here rather than in `packages/auth` so
 * the auth package stays framework-agnostic and unit-testable without a
 * Next.js request context.
 */
export const resolveIdentity = cache(async (): Promise<AuthUser | null> => {
  return resolveIdentityFromHeaders(await headers());
});
