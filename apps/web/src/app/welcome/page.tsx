import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { appRouter, createCallerFactory, createContext } from "@ledgerly/api";
import { isOnboarded } from "@ledgerly/auth";

import { resolveIdentity } from "../../server/identity";

/**
 * apps/web/src/app/welcome/page.tsx — the onboarding gate's target
 * (task 3.8).
 *
 * Deliberately OUTSIDE the `(app)` route group, so it is not gated by the
 * layout that redirects here. It is still matched by `proxy.ts` and still
 * requires a valid Cloudflare Access JWT — it is exempt from onboarding,
 * not from authentication.
 */

const createCaller = createCallerFactory(appRouter);

export default async function WelcomePage() {
  const user = await resolveIdentity();
  if (!user) redirect("/api/auth/sign-out");
  if (isOnboarded(user)) redirect("/");

  async function submit(formData: FormData): Promise<void> {
    "use server";
    // Routed through the tRPC procedure rather than writing to the database
    // here, so onboarding passes the same authorization as every other
    // caller (D-01) instead of a second, parallel path.
    const caller = createCaller(await createContext({ headers: await headers() }));
    await caller.auth.completeOnboarding({
      firstName: String(formData.get("firstName") ?? ""),
      lastName: String(formData.get("lastName") ?? ""),
    });
    redirect("/");
  }

  return (
    <main>
      <h1>Welcome to Ledgerly</h1>
      <p>Tell us your name to finish setting up your account.</p>
      <form action={submit}>
        <label htmlFor="firstName">First name</label>
        <input id="firstName" name="firstName" required maxLength={100} autoComplete="given-name" />

        <label htmlFor="lastName">Last name</label>
        <input id="lastName" name="lastName" required maxLength={100} autoComplete="family-name" />

        <button type="submit">Continue</button>
      </form>
    </main>
  );
}
