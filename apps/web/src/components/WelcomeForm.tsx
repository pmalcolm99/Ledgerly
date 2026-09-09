"use client";

import { useState } from "react";
import { Button, Input } from "@heroui/react";
import { DEFAULT_THEME, THEMES, type ThemeId } from "@ledgerly/shared/themes";

import { applyTheme } from "../lib/applyTheme";

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
 *
 * ## The theme picker
 *
 * Radio inputs INSIDE the same form, not a second form and not a client
 * mutation. Both alternatives are closed off, for different reasons:
 *
 * - A nested `<form>` is silently dropped by browsers, which adopt its submit
 *   button into the outer one (FORKD_LESSONS.md, and the comment below).
 * - `auth.setTheme` is a `protectedProcedure` and this user has not onboarded
 *   yet, so it would be refused. Promoting it to `onboardingProcedure` to fix
 *   that would add a third member to a two-member exemption list that
 *   `routers/auth.ts` argues explicitly for keeping at two. The choice rides
 *   along on `completeOnboarding` instead — one statement, one round trip.
 *
 * `applyTheme` on change gives the preview, because a swatch is a poor proxy
 * for what a theme actually looks like and this is the one screen where the
 * whole page is available to demonstrate it.
 */
export function WelcomeForm({ action }: { action: (formData: FormData) => Promise<void> }) {
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);

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
      <fieldset className="flex flex-col gap-2">
        <legend className="pb-1 text-sm text-default-500">Pick a theme</legend>
        <div className="grid grid-cols-2 gap-2">
          {THEMES.map((entry) => (
            <label
              key={entry.id}
              className={`flex cursor-pointer items-center gap-2 rounded-lg border p-2 text-sm ${
                entry.id === theme ? "border-primary bg-primary-50" : "border-divider"
              }`}
            >
              {/* A real radio, so the value reaches the Server Action through
                  the FormData the browser builds — no hidden mirror field to
                  drift out of sync. Visually hidden rather than `hidden`,
                  which would take it out of the tab order. */}
              <input
                type="radio"
                name="theme"
                value={entry.id}
                checked={entry.id === theme}
                onChange={() => {
                  setTheme(entry.id);
                  applyTheme(entry.id);
                }}
                className="sr-only"
              />
              <span
                aria-hidden
                className="inline-block h-4 w-4 shrink-0 overflow-hidden rounded-full border border-divider"
                style={{
                  background: `linear-gradient(90deg, ${entry.background} 0 50%, ${entry.accent} 50% 100%)`,
                }}
              />
              <span className="min-w-0 truncate">{entry.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <Button type="submit" color="primary" className="mt-1">
        Continue
      </Button>
    </form>
  );
}
