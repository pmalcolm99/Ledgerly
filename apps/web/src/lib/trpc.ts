import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@ledgerly/api";

/**
 * apps/web/src/lib/trpc.ts — the typed client half of the tRPC contract.
 *
 * `AppRouter` is a **type-only** import. `@ledgerly/api`'s entrypoint begins
 * with `import "server-only"`, which throws if it is ever pulled into a client
 * bundle; `import type` is erased entirely at compile time, so no runtime edge
 * to that module exists and the guard is never tripped. Keep it `import type`.
 */
export const trpc = createTRPCReact<AppRouter>();
