import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { edgeEnv } from "@ledgerly/config/edge";
import { verifyAccessJwt } from "@ledgerly/auth/cloudflareAccess";
import { buildAccessDeniedResponse } from "@ledgerly/auth/response";

/**
 * apps/web/src/middleware.ts — the Cloudflare Access perimeter (task 3.6,
 * ARCHITECTURE.md §3.2, contract §11).
 *
 * NAMING: ARCHITECTURE.md §2, PHASES.md task 3.6 and FORKD_AUTH.md all call
 * this file `proxy.ts`. On Next.js 15.5.25 that name does nothing — the
 * framework only recognises `middleware` (there is no PROXY_FILENAME
 * constant; `proxy.ts` is the Next 16 rename). A `proxy.ts` is silently
 * never registered, which leaves the perimeter inert behind a green build.
 * Verified via `.next/server/middleware-manifest.json`: empty when the file
 * is named `proxy.ts`, populated when it is named `middleware.ts`.
 *
 * THIS IS NOT A TRUST BOUNDARY (D-24). It rejects obviously-unauthenticated
 * requests cheaply at the edge and then calls `next()` **attaching
 * nothing** — no identity header of any kind, under any name. The Node
 * layer re-reads `Cf-Access-Jwt-Assertion` from the raw headers and
 * verifies it again, independently, and that second verification is the
 * only thing anything trusts.
 *
 * The consequence worth stating plainly: a gap in the matcher below is a
 * performance regression, not an authentication bypass. Matcher gaps are
 * the most common Next.js auth defect, and this design makes them
 * survivable rather than fatal.
 *
 * There is no NODE_ENV check here. The dev bypass is a startup assertion in
 * packages/config (D-05) — a process with DEV_AUTH_BYPASS=true under
 * NODE_ENV=production does not boot, so it cannot exist at request time.
 */

export default async function middleware(request: NextRequest): Promise<NextResponse | Response> {
  if (edgeEnv.DEV_AUTH_BYPASS) return NextResponse.next();

  // Fail CLOSED on a missing flag. Forkd runs this the other way round —
  // `CF_ACCESS_ENABLED !== "true"` means "skip all auth" (FORKD_AUTH.md
  // §7) — so an unset variable in production silently disables
  // authentication entirely. Here, unset denies.
  if (!edgeEnv.CF_ACCESS_ENABLED) return buildAccessDeniedResponse();

  const token = request.headers.get("cf-access-jwt-assertion");
  const result = await verifyAccessJwt(token);
  if (!result.ok) return buildAccessDeniedResponse(result.reason);

  return NextResponse.next();
}

export const config = {
  // ARCHITECTURE.md §3.2. Ledgerly has no /g/ guest surface and needs no
  // /_next/static Access bypass — nothing anonymous ever needs an asset.
  // /welcome IS matched and requires a valid JWT; it is exempt only from
  // the *onboarding* gate, by living outside the (app) route group.
  matcher: [
    "/((?!_next/|favicon\\.ico|manifest\\.webmanifest|robots\\.txt|sw\\.js|offline\\.html|(?:apple-)?icon[\\w-]*\\.png|api/v1/health(?![\\w-])).*)",
  ],
};
