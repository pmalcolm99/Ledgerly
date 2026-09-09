"use client";

import { Button, Input } from "@heroui/react";

/**
 * The onboarding form's interactive half.
 *
 * Split out of `welcome/page.tsx` for a measurable reason: the page is a
 * Server Component, and importing HeroUI components directly into it made
 * `/welcome` the heaviest route in the app — roughly double every other page,
 * on the one screen a brand-new user sees first, on a phone, over a tunnel.
 * As a Client Component the same imports join the shared client graph the rest
 * of the app already pays for.
 *
 * The Server Action is passed in as a prop. Next supports that, and it keeps
 * `completeOnboarding` running through the tRPC caller server-side — the
 * mutation must not become a client call, because `protectedProcedure` refuses
 * a user who has not onboarded yet, which is precisely this user.
 */
export function WelcomeForm({ action }: { action: (formData: FormData) => Promise<void> }) {
  return (
    // One form, never nested: browsers silently drop an inner <form> and adopt
    // its submit button into the outer one (FORKD_LESSONS.md).
    <form action={action} className="flex flex-col gap-3">
      <div className="flex gap-3">
        <Input
          name="firstName"
          label="First name"
          isRequired
          maxLength={100}
          autoComplete="given-name"
          autoFocus
        />
        <Input
          name="lastName"
          label="Last name"
          isRequired
          maxLength={100}
          autoComplete="family-name"
        />
      </div>
      <Button type="submit" color="primary" className="mt-1">
        Continue
      </Button>
    </form>
  );
}
