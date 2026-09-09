"use client";

import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Navbar,
  NavbarBrand,
  NavbarContent,
  NavbarItem,
  NavbarMenu,
  NavbarMenuItem,
  NavbarMenuToggle,
} from "@heroui/react";
import { useIsFetching } from "@tanstack/react-query";
import { THEMES, type ThemeId } from "@ledgerly/shared/themes";
import { RefreshCw } from "lucide-react";

import { trpc } from "../lib/trpc";
import { applyTheme } from "../lib/applyTheme";

/**
 * apps/web/src/components/Header.tsx — the app shell's header (task 7.2).
 *
 * `pt-[env(safe-area-inset-top)]` is on the Navbar itself, not the body, so
 * the header's own background fills behind the status bar. Padding the body
 * instead leaves a strip of page background above the header that flashes on
 * every load — Forkd hit exactly that and fixed it the same way.
 */

type Nav = { href: string; label: string };

const BASE_NAV: Nav[] = [
  { href: "/", label: "Projects" },
  { href: "/review", label: "Review" },
  { href: "/settings/categories", label: "Categories" },
];

export function Header({
  userName,
  isInstanceOwner,
  theme,
}: {
  userName: string;
  isInstanceOwner: boolean;
  theme: ThemeId;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const isFetching = useIsFetching();
  /**
   * The selected theme, tracked locally.
   *
   * `theme` is a prop resolved during the server render. `chooseTheme` swaps
   * the class on <html> and persists to the database, but the PROP cannot
   * change until the next full server render — so the checkmark stayed on
   * whichever theme was active at page load, no matter what you picked. The
   * page looked right and the menu lied about it.
   *
   * Adjusted DURING RENDER when the prop changes, rather than in an effect:
   * that is React's documented pattern for deriving state from a prop, and an
   * effect here would be a cascading render (and is what
   * `react-hooks/set-state-in-effect` flags). It also keeps the local value
   * correct when the server sends a different theme — a fresh navigation, or
   * this account switching theme in another tab.
   */
  const [selected, setSelected] = useState<ThemeId>(theme);
  const [lastServerTheme, setLastServerTheme] = useState<ThemeId>(theme);
  if (lastServerTheme !== theme) {
    setLastServerTheme(theme);
    setSelected(theme);
  }
  const pathname = usePathname();
  const utils = trpc.useUtils();

  const nav = isInstanceOwner ? [...BASE_NAV, { href: "/admin", label: "Admin" }] : BASE_NAV;

  const setTheme = trpc.auth.setTheme.useMutation({
    onSuccess: () => utils.auth.me.invalidate(),
  });

  function chooseTheme(next: ThemeId) {
    // Swapped on the document immediately so the change is instant, then
    // persisted. The server render is what makes it stick on the next load.
    applyTheme(next);
    setSelected(next);
    setTheme.mutate({ theme: next });
  }

  return (
    <Navbar
      isBordered
      maxWidth="xl"
      isMenuOpen={isMenuOpen}
      onMenuOpenChange={setIsMenuOpen}
      classNames={{ base: "pt-[env(safe-area-inset-top)]", menu: "pt-[env(safe-area-inset-top)]" }}
    >
      <NavbarContent justify="start">
        <NavbarMenuToggle
          className="sm:hidden"
          aria-label={isMenuOpen ? "Close menu" : "Open menu"}
        />
        <NavbarBrand>
          {/* The receipt glyph that used to sit here is removed on purpose —
              we are trying the wordmark alone. To put it back: re-import
              `Receipt` from lucide-react and drop
              `<Receipt className="h-5 w-5 text-primary" aria-hidden />`
              immediately before the span. Nothing else changes; the `gap-2`
              below is already sized for it. */}
          <NextLink href="/" className="flex items-center gap-2">
            {/* The wordmark, in the vendored script face (layout.tsx sets the
                variable). `leading-none` plus the nudge because a script face
                sits high in its box. */}
            <span className="font-brand translate-y-[0.06em] text-2xl leading-none">Ledgerly</span>
          </NextLink>
        </NavbarBrand>
      </NavbarContent>

      <NavbarContent className="hidden gap-6 sm:flex" justify="center">
        {nav.map((item) => (
          <NavbarItem key={item.href} isActive={pathname === item.href}>
            <NextLink
              href={item.href}
              className={pathname === item.href ? "text-primary" : "text-foreground"}
            >
              {item.label}
            </NextLink>
          </NavbarItem>
        ))}
      </NavbarContent>

      <NavbarContent justify="end">
        {/* Left of the user's name, deliberately. An installed iOS PWA has no
            URL bar, no reload button and no pull-to-refresh, so there is
            otherwise NO way to force a refetch short of killing the app. */}
        <NavbarItem>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label="Refresh"
            onPress={() => void utils.invalidate()}
          >
            {/* Driven by `useIsFetching`, not by local state: the spin then
                reflects work actually in flight — including a background
                extraction poll — rather than a fixed animation that lies
                about what the app is doing. */}
            <RefreshCw className={`h-4 w-4 ${isFetching > 0 ? "animate-spin" : ""}`} aria-hidden />
          </Button>
        </NavbarItem>
        <Dropdown>
          <DropdownTrigger>
            <Button variant="flat" size="sm">
              {userName}
            </Button>
          </DropdownTrigger>
          {/* A flat array, not a fragment: react-aria builds its collection
              by walking children, and a fragment wrapper hides them from it. */}
          <DropdownMenu aria-label="Account menu">
            {[
              ...THEMES.map((entry) => (
                <DropdownItem
                  key={entry.id}
                  textValue={entry.label}
                  onPress={() => chooseTheme(entry.id)}
                  startContent={
                    // Page colour and accent together, split down the middle.
                    // The previous swatch showed `background` only, and four
                    // of the five themes are near-black — so it conveyed
                    // nothing about which theme you were choosing.
                    <span
                      aria-hidden
                      className="inline-block h-4 w-4 overflow-hidden rounded-full border border-divider"
                      style={{
                        background: `linear-gradient(90deg, ${entry.background} 0 50%, ${entry.accent} 50% 100%)`,
                      }}
                    />
                  }
                  endContent={entry.id === selected ? <span aria-hidden>✓</span> : null}
                >
                  {entry.label}
                </DropdownItem>
              )),
              <DropdownItem
                key="sign-out"
                textValue="Sign out"
                color="danger"
                className="text-danger"
                href="/api/auth/sign-out"
              >
                Sign out
              </DropdownItem>,
            ]}
          </DropdownMenu>
        </Dropdown>
      </NavbarContent>

      <NavbarMenu>
        {nav.map((item) => (
          <NavbarMenuItem key={item.href}>
            <NextLink
              href={item.href}
              className="w-full py-2 text-lg"
              onClick={() => setIsMenuOpen(false)}
            >
              {item.label}
            </NextLink>
          </NavbarMenuItem>
        ))}
      </NavbarMenu>
    </Navbar>
  );
}
