import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter, createContext } from "@ledgerly/api";

/**
 * The tRPC HTTP handler. `createContext` resolves identity once per request
 * from the raw headers and passes `ctx.user` down (D-24) — the middleware
 * attaches nothing and is not trusted.
 */
function handler(request: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: () => createContext({ headers: request.headers }),
  });
}

export { handler as GET, handler as POST };
