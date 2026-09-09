import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { appRouter, createCallerFactory, createContext } from "@ledgerly/api";
import { isOnboarded } from "@ledgerly/auth";
import { Receipt } from "lucide-react";

import { WelcomeForm } from "../../components/WelcomeForm";
import { resolveIdentity } from "../../server/identity";

/**
 * apps/web/src/app/welcome/page.tsx — onboarding (task 3.8, brief §1).
 *
 * Deliberately OUTSIDE the `(app)` route group, so it is not gated by the
 * layout that redirects here. It is still matched by `middleware.ts` and still
 * requires a valid Cloudflare Access JWT — it is exempt from onboarding, not
 * from authentication.
 *
 * Still a Server Action rather than a client mutation: it runs before the user
 * is onboarded, which is exactly the state `protectedProcedure` refuses, so
 * routing it through the server-side caller keeps it on `onboardingProcedure`
 * without the client needing a special case.
 *
 * Shown once — the `(app)` layout only redirects here while `onboarded_at` is
 * null, and this page redirects away once it is set.
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
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col justify-center px-4 py-8">
      <div className="rounded-xl border border-divider bg-content1 p-6 shadow-small">
        <div className="mb-4 flex items-center gap-2">
          <Receipt className="h-6 w-6 text-primary" aria-hidden />
          <h1 className="text-2xl font-bold">Welcome to Ledgerly</h1>
        </div>
        <p className="mb-4 text-sm text-default-500">
          Tell us your name to finish setting up your account. This is how you&apos;ll appear to
          anyone you share a project with.
        </p>
        <WelcomeForm action={submit} />
      </div>
    </main>
  );
}
