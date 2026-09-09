"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";
import { HeroUIProvider } from "@heroui/react";
import { QueryCache, QueryClient, MutationCache } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";

import { trpc } from "../lib/trpc";
import { isOnboardingRequiredError } from "../lib/onboarding";

/**
 * apps/web/src/app/providers.tsx — HeroUI + React Query + tRPC (task 7.2).
 *
 * `HeroUIProvider`'s `navigate` is wired to the App Router so HeroUI's own
 * links and menus do client-side navigation rather than full page loads —
 * which matters a lot on a phone over a tunnel.
 */
export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();

  // Both clients are created in state, not at module scope. A module-scope
  // QueryClient is shared across every request in the same server process,
  // which would leak one user's cached receipts into another user's render.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The tunnel makes refetch-on-focus expensive and the data is not
            // that volatile; polling is opt-in per query (the capture flow
            // turns it on deliberately while extraction runs).
            refetchOnWindowFocus: false,
            staleTime: 30_000,
            retry: (failureCount, error) => !isOnboardingRequiredError(error) && failureCount < 2,
          },
        },
        queryCache: new QueryCache({
          onError: (error) => {
            if (isOnboardingRequiredError(error)) router.replace("/welcome");
          },
        }),
        mutationCache: new MutationCache({
          onError: (error) => {
            if (isOnboardingRequiredError(error)) router.replace("/welcome");
          },
        }),
      }),
  );

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: "/api/trpc",
          // Must match the server's transformer (packages/api/src/trpc.ts);
          // superjson is what carries Date objects across intact.
          transformer: superjson,
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {/*
          `disableAnimation` is deliberate, and it is a correctness fix rather
          than a taste one.

          HeroUI's overlays animate through framer-motion, and with this
          combination (HeroUI 2.8 + React 19) the modal's enter animation never
          runs: the wrapper stays at `opacity: 0` forever, so an opened dialog
          is present in the DOM, focus-trapping the page, and invisible.
          Verified directly in Chrome and reproduced in WebKit, on both
          framer-motion 11 and 12.

          Turning the animations off renders overlays immediately and
          correctly. It also suits the app: this runs on a phone over a
          Cloudflare Tunnel, where overlay transitions are pure cost, and
          FORKD_LESSONS.md's iOS bug list is an argument for fewer moving
          parts, not more.
        */}
        <HeroUIProvider navigate={router.push} disableAnimation>
          {children}
        </HeroUIProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
