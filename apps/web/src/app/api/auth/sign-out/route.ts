import { redirect } from "next/navigation";
import { edgeEnv } from "@ledgerly/config/edge";

/**
 * apps/web/src/app/api/auth/sign-out/route.ts — sign-out (task 3.9, D-04).
 *
 * A Route Handler, never a Server Component: Next.js 15 forbids cookie
 * writes in RSCs, and Forkd's sign-out page silently failed to delete its
 * cookie for exactly that reason (FORKD_LESSONS.md).
 *
 * Under D-03 there is no app session to clear, so the redirect to
 * Cloudflare Access's logout endpoint is the ENTIRE operation — and it is
 * also the only thing that ever actually logged a Forkd user out. Clearing
 * a local session while `CF_Authorization` stays valid just re-authenticates
 * the user silently on their next visit.
 *
 * The nav links here with a plain `<a href>`, never `<Link>`, so the
 * browser issues a real navigation rather than a client-side transition.
 */
export function GET(): never {
  const teamDomain = edgeEnv.CF_ACCESS_TEAM_DOMAIN;

  // With no team domain configured there is nothing to log out of; send the
  // user somewhere harmless rather than constructing a broken URL.
  redirect(teamDomain ? `https://${teamDomain}/cdn-cgi/access/logout` : "/");
}
