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
import { THEMES, type ThemeId } from "@ledgerly/shared/themes";
import { Receipt } from "lucide-react";

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
          <NextLink href="/" className="flex items-center gap-2 text-xl font-bold">
            <Receipt className="h-5 w-5 text-primary" aria-hidden />
            Ledgerly
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
                    <span
                      aria-hidden
                      className="inline-block h-3 w-3 rounded-full border border-divider"
                      style={{ background: entry.background }}
                    />
                  }
                  endContent={entry.id === theme ? <span aria-hidden>✓</span> : null}
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
