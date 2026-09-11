"use client";

import NextLink from "next/link";
import { usePathname } from "next/navigation";

/**
 * apps/web/src/components/AdminSubNav.tsx — the two admin screens.
 *
 * Admin was one page until the Logs tab; rather than grow the header's flat
 * nav with a second owner-only entry, the split lives here where it belongs to
 * the section rather than to the whole app.
 */
const TABS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/logs", label: "Logs" },
] as const;

export function AdminSubNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 border-b border-divider pb-2" aria-label="Admin sections">
      {TABS.map((tab) => {
        // Exact match, not startsWith: "/admin" is a prefix of "/admin/logs",
        // so a prefix test would light both tabs at once.
        const active = pathname === tab.href;
        return (
          <NextLink
            key={tab.href}
            href={tab.href}
            className={`rounded-md px-3 py-1.5 text-sm ${
              active ? "bg-default-100 font-semibold" : "text-default-500 hover:text-foreground"
            }`}
          >
            {tab.label}
          </NextLink>
        );
      })}
    </nav>
  );
}
