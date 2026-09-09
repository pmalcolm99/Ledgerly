import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * apps/web/src/sw.test.ts — behavioural tests for the real service worker.
 *
 * `public/sw.js` is a classic worker script: not bundled, not importable, and
 * not linted. So rather than re-implement its rules here (which would test a
 * copy and prove nothing about what ships), this evaluates THE SHIPPED FILE in
 * a synthetic worker scope with fake `caches`/`clients`, then drives the
 * handlers it registers using real `Request`/`Response` objects from Node 22's
 * globals.
 *
 * The cases that matter most are the Cloudflare Access ones. An expired Access
 * session answers a navigation with a redirect to a login page; a worker that
 * caches that as the app shell bricks the installed PWA until the user clears
 * site data by hand.
 */

const SW_SOURCE = readFileSync(path.join(import.meta.dirname, "..", "public", "sw.js"), "utf8");

type Handlers = Record<string, (event: unknown) => void>;

class FakeCache {
  store = new Map<string, Response>();

  async put(request: Request | string, response: Response) {
    this.store.set(typeof request === "string" ? request : request.url, response);
  }
  async match(request: Request | string) {
    return this.store.get(typeof request === "string" ? request : request.url);
  }
}

function setupWorker() {
  const handlers: Handlers = {};
  const cache = new FakeCache();
  const deletedCaches: string[] = [];

  const scope = {
    location: { origin: "https://ledgerly.example" },
    registration: { navigationPreload: { enable: vi.fn(async () => {}) } },
    clients: { claim: vi.fn(async () => {}) },
    skipWaiting: vi.fn(async () => {}),
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      handlers[type] = handler;
    },
    caches: {
      open: async () => cache,
      keys: async () => ["ledgerly-shell-v1", "ledgerly-shell-v0"],
      delete: async (name: string) => {
        deletedCaches.push(name);
        return true;
      },
      match: async (request: Request | string) => cache.match(request),
    },
  };

  const run = new Function("self", "caches", "fetch", "Response", "URL", SW_SOURCE);
  const fetchMock = vi.fn();
  run(scope, scope.caches, fetchMock, Response, URL);

  return { handlers, cache, scope, fetchMock, deletedCaches };
}

/** Drives the fetch handler and returns what it responded with, or the string
 *  "not-intercepted" when it declined to call respondWith at all. */
async function runFetch(
  handlers: Handlers,
  request: Request,
  preloadResponse?: Promise<Response | undefined>,
): Promise<Response | "not-intercepted"> {
  let responded: Promise<Response> | null = null;
  handlers.fetch!({
    request,
    preloadResponse,
    respondWith: (value: Promise<Response>) => {
      responded = value;
    },
  });
  if (responded === null) return "not-intercepted";
  return await responded;
}

/**
 * `Request.mode` is forbidden from being set to "navigate" by script — the
 * Fetch standard reserves it for the browser's own navigations — so a real
 * navigation request cannot be constructed here. It is stamped on directly,
 * which is precisely what the browser hands the worker.
 */
function navigationRequest(url = "https://ledgerly.example/projects/abc") {
  const request = new Request(url, { method: "GET" });
  Object.defineProperty(request, "mode", { value: "navigate" });
  return request;
}

/**
 * `status`, `type` and `redirected` are prototype getters on Response, and
 * status 0 (what an opaque or opaqueredirect response actually reports) cannot
 * be passed to the constructor at all — the valid range is 200-599. So the
 * response is built with a legal status and the three properties are shadowed
 * on the instance, which is exactly what the worker reads.
 */
function responseWith(init: {
  status?: number;
  type?: string;
  redirected?: boolean;
  body?: string;
}): Response {
  const status = init.status ?? 200;
  const response = new Response(status === 0 ? null : (init.body ?? "ok"), { status: 200 });
  Object.defineProperty(response, "status", { value: status });
  Object.defineProperty(response, "type", { value: init.type ?? "basic" });
  Object.defineProperty(response, "redirected", { value: init.redirected ?? false });
  return response;
}

let worker: ReturnType<typeof setupWorker>;

beforeEach(() => {
  worker = setupWorker();
});

describe("install", () => {
  async function runInstall() {
    let waited: Promise<unknown> | null = null;
    worker.handlers.install!({ waitUntil: (value: Promise<unknown>) => (waited = value) });
    return waited;
  }

  it("precaches the shell", async () => {
    worker.fetchMock.mockResolvedValue(responseWith({ status: 200 }));
    await runInstall();
    expect(worker.cache.store.has("/offline.html")).toBe(true);
    expect(worker.cache.store.has("/icon-192.png")).toBe(true);
    expect(worker.scope.skipWaiting).toHaveBeenCalled();
  });

  it("survives one optional asset failing, as long as the offline page lands", async () => {
    worker.fetchMock.mockImplementation(async (url: string) =>
      url === "/icon-maskable.png" ? responseWith({ status: 404 }) : responseWith({ status: 200 }),
    );
    await runInstall();
    expect(worker.cache.store.has("/offline.html")).toBe(true);
    expect(worker.cache.store.has("/icon-maskable.png")).toBe(false);
  });

  /**
   * `cache.add` would have stored this: the Cache API rejects opaque and
   * non-ok responses but does not check `redirected`, so a 200 arrived at
   * through an Access login redirect was storable as the offline page.
   */
  it("refuses to precache a 200 reached through a redirect", async () => {
    worker.fetchMock.mockResolvedValue(responseWith({ status: 200, redirected: true }));
    await expect(runInstall()).rejects.toThrow();
    expect(worker.cache.store.size).toBe(0);
  });

  it("fails the install when the offline page cannot be precached", async () => {
    worker.fetchMock.mockImplementation(async (url: string) =>
      url === "/offline.html" ? responseWith({ status: 500 }) : responseWith({ status: 200 }),
    );
    await expect(runInstall()).rejects.toThrow();
  });
});

describe("activate", () => {
  it("enables navigation preload and drops caches from older versions", async () => {
    let waited: Promise<unknown> | null = null;
    worker.handlers.activate!({ waitUntil: (value: Promise<unknown>) => (waited = value) });
    await waited;
    expect(worker.scope.registration.navigationPreload.enable).toHaveBeenCalled();
    expect(worker.deletedCaches).toEqual(["ledgerly-shell-v0"]);
    expect(worker.scope.clients.claim).toHaveBeenCalled();
  });
});

describe("the Cloudflare Access hazard", () => {
  it("passes a 302 login redirect through and caches NOTHING", async () => {
    const redirect = responseWith({ status: 302, type: "basic" });
    worker.fetchMock.mockResolvedValue(redirect);

    const result = await runFetch(worker.handlers, navigationRequest(), Promise.resolve(undefined));

    expect(result).not.toBe("not-intercepted");
    expect((result as Response).status).toBe(302);
    // The whole point: nothing was written to the cache.
    expect(worker.cache.store.size).toBe(0);
  });

  it("does not cache a 200 that was ARRIVED AT through a redirect", async () => {
    // The subtle one: the login page finally answers 200, but `redirected`
    // is true, so the body is the login page, not the app.
    const followed = responseWith({ status: 200, redirected: true, body: "<login/>" });
    worker.fetchMock.mockResolvedValue(followed);

    await runFetch(worker.handlers, navigationRequest(), Promise.resolve(undefined));
    expect(worker.cache.store.size).toBe(0);
  });

  it("does not substitute the offline page for a 403", async () => {
    // A user whose Access session expired has a working connection. Telling
    // them they are offline would be actively misleading.
    worker.fetchMock.mockResolvedValue(responseWith({ status: 403 }));
    const result = await runFetch(worker.handlers, navigationRequest(), Promise.resolve(undefined));
    expect((result as Response).status).toBe(403);
    expect(worker.cache.store.size).toBe(0);
  });

  it("never caches a navigation, even a perfectly good one", async () => {
    worker.fetchMock.mockResolvedValue(responseWith({ status: 200 }));
    await runFetch(worker.handlers, navigationRequest(), Promise.resolve(undefined));
    expect(worker.cache.store.size).toBe(0);
  });

  it("serves the offline page only when the network itself fails", async () => {
    worker.cache.store.set("/offline.html", new Response("offline page"));
    worker.fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await runFetch(worker.handlers, navigationRequest(), Promise.resolve(undefined));
    await expect((result as Response).text()).resolves.toBe("offline page");
  });
});

describe("what is cached", () => {
  it("caches a 200 basic /_next/static asset", async () => {
    worker.fetchMock.mockResolvedValue(responseWith({ status: 200 }));
    const request = new Request("https://ledgerly.example/_next/static/chunks/main-abc.js");
    await runFetch(worker.handlers, request);
    expect(worker.cache.store.has(request.url)).toBe(true);
  });

  it("serves a cached static asset without going to the network", async () => {
    const request = new Request("https://ledgerly.example/_next/static/chunks/main-abc.js");
    worker.cache.store.set(request.url, new Response("cached chunk"));
    const result = await runFetch(worker.handlers, request);
    await expect((result as Response).text()).resolves.toBe("cached chunk");
    expect(worker.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a redirect", { status: 302 }],
    ["a 404", { status: 404 }],
    ["a 500", { status: 500 }],
    ["an opaque cross-origin response", { status: 0, type: "opaque" }],
    ["an opaqueredirect response", { status: 0, type: "opaqueredirect" }],
    ["a 200 reached through a redirect", { status: 200, redirected: true }],
  ])("refuses to cache %s", async (_label, init) => {
    worker.fetchMock.mockResolvedValue(responseWith(init));
    const request = new Request("https://ledgerly.example/_next/static/chunks/x.js");
    await runFetch(worker.handlers, request);
    expect(worker.cache.store.size).toBe(0);
  });
});

describe("what is never intercepted", () => {
  it.each([
    ["tRPC", "https://ledgerly.example/api/trpc/receipts.list"],
    ["receipt images", "https://ledgerly.example/api/images/abc/thumb"],
    ["the upload endpoint", "https://ledgerly.example/api/receipts/upload"],
    ["sign-out", "https://ledgerly.example/api/auth/sign-out"],
    ["an RSC payload", "https://ledgerly.example/projects/abc?_rsc=1a2b3"],
  ])("leaves %s entirely to the browser", async (_label, url) => {
    const result = await runFetch(worker.handlers, new Request(url));
    expect(result).toBe("not-intercepted");
    expect(worker.cache.store.size).toBe(0);
  });

  it("ignores non-GET requests so an upload is never replayed", async () => {
    const result = await runFetch(
      worker.handlers,
      new Request("https://ledgerly.example/api/receipts/upload", { method: "POST" }),
    );
    expect(result).toBe("not-intercepted");
  });

  it("ignores cross-origin requests", async () => {
    const result = await runFetch(worker.handlers, new Request("https://example.com/thing.js"));
    expect(result).toBe("not-intercepted");
  });
});

describe("standing guarantees", () => {
  it("contains no stale-while-revalidate in actual code", () => {
    // Forkd's worker cached every photo that way and doubled tunnel requests
    // on photo-heavy pages (FORKD_LESSONS.md). ARCHITECTURE.md §9 makes its
    // absence a stated property, so it is asserted rather than assumed.
    //
    // Comments are stripped first: sw.js's own header explains why the
    // strategy is absent, and matching that sentence would fail the very
    // assertion it documents.
    const code = SW_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/stale-while-revalidate/i);
    expect(code).not.toMatch(/revalidate/i);
  });

  it("uses the cache name ARCHITECTURE.md §9 specifies", () => {
    expect(SW_SOURCE).toContain("ledgerly-shell-v1");
  });
});
