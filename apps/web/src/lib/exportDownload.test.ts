import { describe, expect, it, vi } from "vitest";

import { browserSaveDeps, filenameFromDisposition, saveExport } from "./exportDownload";
import type { SaveDeps } from "./exportDownload";

/**
 * apps/web/src/lib/exportDownload.test.ts — D-49.
 *
 * The assertions that matter are about ROUTE: an installed app must never be
 * sent to a new browser view, and a browser tab must never be made to buffer a
 * streamed response. Those are the two halves of the reported bug, and neither
 * is visible from looking at the component.
 */

function deps(overrides: Partial<SaveDeps> = {}): SaveDeps & {
  calls: { tab: string[]; shared: File[][]; saved: [Blob, string][] };
} {
  const calls = { tab: [] as string[], shared: [] as File[][], saved: [] as [Blob, string][] };
  return {
    calls,
    installed: true,
    fetchImpl: vi.fn(
      async () =>
        new Response("spreadsheet-bytes", {
          status: 200,
          headers: {
            "content-type": "text/csv",
            "content-disposition": 'attachment; filename="kitchen-remodel_2026-09-13.csv"',
          },
        }),
    ) as unknown as typeof fetch,
    canShareFiles: () => true,
    share: async (data) => {
      calls.shared.push(data.files);
    },
    openTab: (url) => calls.tab.push(url),
    saveBlob: (blob, filename) => calls.saved.push([blob, filename]),
    ...overrides,
  };
}

describe("filenameFromDisposition", () => {
  it("reads the quoted filename the export handler sends", () => {
    expect(
      filenameFromDisposition('attachment; filename="kitchen-remodel_2026-09-13.xlsx"', "x.xlsx"),
    ).toBe("kitchen-remodel_2026-09-13.xlsx");
  });

  it("prefers the RFC 5987 form when one is present", () => {
    expect(
      filenameFromDisposition(
        "attachment; filename=\"fallback.csv\"; filename*=UTF-8''caf%C3%A9_2026.csv",
        "x.csv",
      ),
    ).toBe("café_2026.csv");
  });

  /** A wrong name is a far better outcome than a failed download. */
  it("falls back rather than throwing on a header it cannot parse", () => {
    expect(filenameFromDisposition("attachment", "fallback.csv")).toBe("fallback.csv");
    expect(filenameFromDisposition(null, "fallback.csv")).toBe("fallback.csv");
    expect(filenameFromDisposition("attachment; filename*=UTF-8''%%%", "fallback.csv")).toBe(
      "fallback.csv",
    );
  });
});

describe("saveExport — a browser tab", () => {
  /**
   * The path that was never broken. It streams, so it must not start
   * buffering: a `fetch` here would read a response that is generated as it is
   * sent and can be far larger than anything a phone exports.
   */
  it("opens a tab and never touches the network itself", async () => {
    const d = deps({ installed: false });
    const result = await saveExport("/api/projects/p/export?format=csv", "x.csv", d);

    expect(result).toEqual({ ok: true, via: "tab" });
    expect(d.calls.tab).toEqual(["/api/projects/p/export?format=csv"]);
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("saveExport — an installed app", () => {
  /** THE ASSERTION THIS FILE EXISTS FOR. An installed iOS app opens a
   *  `target="_blank"` link in a view that cannot save an attachment — it
   *  renders blank and discards the body. It must never be sent there. */
  it("never opens a browser view", async () => {
    const d = deps();
    await saveExport("/api/projects/p/export?format=csv", "x.csv", d);
    expect(d.calls.tab).toEqual([]);
  });

  it("hands the file to the share sheet, named by the server", async () => {
    const d = deps();
    const result = await saveExport("/api/projects/p/export?format=csv", "x.csv", d);

    expect(result).toEqual({ ok: true, via: "share" });
    expect(d.calls.shared).toHaveLength(1);
    expect(d.calls.shared[0]![0]!.name).toBe("kitchen-remodel_2026-09-13.csv");
  });

  it("sends credentials, so the Access cookie still rides along", async () => {
    const d = deps();
    await saveExport("/api/projects/p/export", "x.csv", d);
    expect(d.fetchImpl).toHaveBeenCalledWith("/api/projects/p/export", {
      credentials: "same-origin",
      headers: { "x-ledgerly-inline": "1" },
    });
  });

  /**
   * THE SECOND HALF OF THE iOS FIX. WebKit hands an `attachment` response to
   * its download machinery before the JavaScript that requested it sees the
   * body — and an installed app has no download UI to hand it to, so the fetch
   * rejects outright. This request is going to save the file itself, so it asks
   * for the bytes rather than a download.
   */
  it("asks the server not to mark the response an attachment", async () => {
    const d = deps();
    await saveExport("/api/projects/p/export", "x.csv", d);
    const init = (d.fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]![1];
    expect((init.headers as Record<string, string>)["x-ledgerly-inline"]).toBe("1");
  });

  /** The browser-tab path must NOT ask for inline — there the browser is doing
   *  the saving, and an inline CSV would render as text instead. */
  it("does not ask for inline on the tab path", async () => {
    const d = deps({ installed: false });
    await saveExport("/api/projects/p/export", "x.csv", d);
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  /** Dismissing the sheet is a completed interaction. Falling through to a
   *  second save would be a surprising thing to do to someone who said no. */
  it("treats a dismissed share sheet as done, not as a failure", async () => {
    const abort = new Error("share cancelled");
    abort.name = "AbortError";
    const d = deps({ share: () => Promise.reject(abort) });

    const result = await saveExport("/api/projects/p/export", "x.csv", d);
    expect(result).toEqual({ ok: true, via: "share" });
    expect(d.calls.saved).toEqual([]);
  });

  /** iOS wants the share inside a user gesture, and the `await` on the fetch
   *  can outlive it. One of the two routes usually works, so a refusal falls
   *  through rather than being reported. */
  it("falls back to a blob save when the share is refused", async () => {
    const notAllowed = new Error("not allowed");
    notAllowed.name = "NotAllowedError";
    const d = deps({ share: () => Promise.reject(notAllowed) });

    const result = await saveExport("/api/projects/p/export", "x.csv", d);
    expect(result).toEqual({ ok: true, via: "blob" });
    expect(d.calls.saved[0]![1]).toBe("kitchen-remodel_2026-09-13.csv");
  });

  it("falls back to a blob save where sharing files is unsupported", async () => {
    const d = deps({ canShareFiles: () => false });
    const result = await saveExport("/api/projects/p/export", "x.csv", d);
    expect(result).toEqual({ ok: true, via: "blob" });
  });

  /**
   * The export handler answers a rate limit as `text/plain`, written to be
   * read by a person. Replacing it with a status code would throw away the
   * only part of the response that helps.
   */
  it("surfaces the server's own error text", async () => {
    const d = deps({
      fetchImpl: (async () =>
        new Response("Too many exports. Try again shortly.", {
          status: 429,
        })) as unknown as typeof fetch,
    });

    const result = await saveExport("/api/projects/p/export", "x.csv", d);
    expect(result).toEqual({ ok: false, message: "Too many exports. Try again shortly." });
    expect(d.calls.saved).toEqual([]);
  });

  it("reports a status when the server sends no message", async () => {
    const d = deps({
      fetchImpl: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
    });
    const result = await saveExport("/api/projects/p/export", "x.csv", d);
    expect(result).toEqual({ ok: false, message: "The export failed (500)." });
  });

  /**
   * A silent failure is the one kind this bug was — and a failure that names
   * itself is the difference between one round trip and three. The first
   * version said only "check your connection", which was a guess dressed as a
   * diagnosis: the request was reaching the server perfectly well.
   */
  it("reports the underlying error rather than guessing at the cause", async () => {
    const d = deps({
      fetchImpl: (() => Promise.reject(new TypeError("Load failed"))) as unknown as typeof fetch,
    });
    const result = await saveExport("/api/projects/p/export", "x.csv", d);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("TypeError");
    expect(result.message).toContain("Load failed");
  });
});

/**
 * THE ONLY TESTS THAT TOUCH `browserSaveDeps`, and the reason they exist.
 *
 * The injection seam above lets the routing logic be tested without a browser
 * — which means the one function that actually touches the browser was the one
 * function no test ever ran. It shipped as `fetchImpl: fetch`, a bare
 * reference, and `saveExport` calls it as `deps.fetchImpl(...)`: a method call,
 * so `this` is the deps object. WebKit enforces the receiver on `Window.fetch`
 * and threw *"Can only call Window.fetch on instances of Window"*. Chrome,
 * Firefox and Node are all lenient, so it failed on exactly one platform and
 * nowhere the suite was looking.
 *
 * These stub the platform with implementations that RECORD their receiver, so
 * the wrongly-bound call is visible in an environment that would otherwise
 * accept it.
 */
describe("browserSaveDeps", () => {
  function withFakeWindow<T>(body: () => T): T {
    const globals = globalThis as unknown as Record<string, unknown>;
    const realWindow = globals.window;
    const realFetch = globals.fetch;
    globals.window = {
      navigator: { standalone: true },
      matchMedia: () => ({ matches: false }),
    };
    try {
      return body();
    } finally {
      globals.window = realWindow;
      globals.fetch = realFetch;
    }
  }

  it("calls fetch with the right receiver, not with the deps object", async () => {
    const receivers: unknown[] = [];
    let deps: ReturnType<typeof browserSaveDeps> | undefined;

    await withFakeWindow(async () => {
      (globalThis as unknown as Record<string, unknown>).fetch = function (this: unknown) {
        receivers.push(this);
        return Promise.resolve(new Response("ok"));
      };

      deps = browserSaveDeps();
      // Invoked exactly as `saveExport` invokes it — as a method on `deps`.
      await deps.fetchImpl("/api/projects/p/export");
    });

    expect(receivers).toHaveLength(1);
    // THE ASSERTION. With `fetchImpl: fetch` the receiver is the deps object,
    // which is what WebKit rejects. A plain call from inside a wrapper gives
    // `undefined` under strict-mode ESM, and the real `Window.fetch` treats
    // that as the global — which is the whole point.
    expect(receivers[0]).not.toBe(deps);
  });

  it("reports an installed app from the legacy iOS flag", () => {
    withFakeWindow(() => {
      expect(browserSaveDeps().installed).toBe(true);
    });
  });
});
