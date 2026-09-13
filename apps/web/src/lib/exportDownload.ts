/**
 * apps/web/src/lib/exportDownload.ts — getting an export onto the device
 * (D-49).
 *
 * ## Two bugs, one cause
 *
 * An installed iOS PWA has exactly one document and no browser chrome, and
 * that breaks both obvious ways to hand over a file:
 *
 *  - `window.location.assign(url)` downloads correctly and gives the whole
 *    screen to the "Open in Excel" sheet, with no back button and no history
 *    entry. The only way out was to kill the app. That was the first bug.
 *  - A `target="_blank"` anchor fixed the way back — the link opens in an
 *    in-app browser view with an X to dismiss — but that view **cannot save a
 *    `Content-Disposition: attachment` response at all.** It renders a blank
 *    white page and discards the body. That was the second bug, and it is
 *    worse than the first, because the first one at least produced a file.
 *
 * The mistake both times was treating this as a NAVIGATION problem. In a
 * standalone PWA it is not: there is nowhere to navigate to. The file has to
 * be fetched by the page that already exists and handed to the OS directly.
 *
 * ## What this does instead
 *
 * On an installed app: `fetch` the export, then offer it through the Web Share
 * API, which opens the native sheet ("Save to Files", "Open in Excel") without
 * the document ever going anywhere. Dismissing the sheet returns you exactly
 * where you were, because you never left.
 *
 * Everywhere else — desktop, and Safari as a normal browser — the anchor is
 * kept. It streams, so nothing is buffered, and `Content-Disposition` names
 * the file. That path was never broken and the fix must not "improve" it: the
 * response is generated as it is sent and can be far larger than a phone
 * export.
 *
 * ## What buffering costs, and why it is acceptable here
 *
 * The share path reads the whole body into memory before it can construct a
 * `File`. There is no streaming alternative — the Web Share API takes a
 * complete file. This is confined to the installed-app path on purpose: a
 * phone exporting a project is the case where the file is small and the
 * alternative is no file at all.
 */

export type SaveResult =
  { ok: true; via: "tab" | "share" | "blob" } | { ok: false; message: string };

/**
 * Whether this document is an installed app rather than a browser tab.
 *
 * `display-mode: standalone` is the standard; `navigator.standalone` is the
 * iOS-only predecessor and is still what older iOS reports. Both are checked
 * because the whole point is to catch the iOS case.
 *
 * Feature detection, not a UA sniff: the behaviour that matters is "this
 * document has no browser chrome to navigate away into", and that is exactly
 * what these two report.
 */
export function isInstalledApp(win: Window = window): boolean {
  const legacyStandalone = (win.navigator as Navigator & { standalone?: boolean }).standalone;
  if (legacyStandalone === true) return true;
  return win.matchMedia?.("(display-mode: standalone)").matches === true;
}

/**
 * The server's filename, out of `Content-Disposition`.
 *
 * The header is built by `packages/api/src/export/filename.ts` as
 * `attachment; filename="slug_date.ext"`, where the slug is ASCII by
 * construction — so a quoted-string parse is enough and the RFC 5987
 * `filename*` form never appears. `filename*` is still preferred when present,
 * because that is what the RFC says to do and a future non-ASCII project name
 * would produce one.
 *
 * Falls back rather than throwing: a file saved under a slightly wrong name is
 * a far better outcome than an export that fails on a header.
 */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;

  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // A malformed percent-encoding is not worth failing a download over.
    }
  }

  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header);
  if (quoted?.[1]) return quoted[1];

  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  return bare?.[1]?.trim() || fallback;
}

/** The dependencies this module touches, injected so the decision logic can be
 *  tested without a DOM or a network. */
export type SaveDeps = {
  fetchImpl: typeof fetch;
  installed: boolean;
  canShareFiles: (files: File[]) => boolean;
  share: (data: { files: File[]; title?: string }) => Promise<void>;
  openTab: (url: string) => void;
  saveBlob: (blob: Blob, filename: string) => void;
};

export async function saveExport(
  url: string,
  fallbackName: string,
  deps: SaveDeps,
): Promise<SaveResult> {
  // The unbroken path, left exactly as it was: streamed, unbuffered, named by
  // the server.
  if (!deps.installed) {
    deps.openTab(url);
    return { ok: true, via: "tab" };
  }

  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      // `same-origin` credentials so the Cloudflare Access cookie rides along —
      // the same property the anchor had for free, and the one thing a `fetch`
      // rewrite could plausibly have broken.
      credentials: "same-origin",
      // Ask the server NOT to mark this an attachment. WebKit hands an
      // attachment response to its download machinery before the JavaScript
      // that asked for it can see the body, and an installed app has no
      // download UI to hand it to — so the fetch rejects and nothing arrives.
      // This is the request that is going to save the file itself, so it wants
      // the bytes, not a download (D-49).
      headers: { "x-ledgerly-inline": "1" },
    });
  } catch (error) {
    // The underlying reason is included. The first version of this said only
    // "check your connection", which was a guess dressed as a diagnosis — the
    // request was reaching the server perfectly well and being diverted after
    // it arrived. A failure that names itself is the difference between one
    // round trip and three.
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, message: `The export could not be downloaded (${detail}).` };
  }

  if (!response.ok) {
    // The export handler answers errors as `text/plain` (a rate limit, a
    // missing project), and that text is written to be read by a person — so
    // it is shown rather than replaced with a status code.
    const body = await response.text().catch(() => "");
    const message = body.trim();
    return {
      ok: false,
      message: message.length > 0 ? message : `The export failed (${response.status}).`,
    };
  }

  const blob = await response.blob();
  const filename = filenameFromDisposition(
    response.headers.get("content-disposition"),
    fallbackName,
  );
  const file = new File([blob], filename, {
    type: blob.type || "application/octet-stream",
  });

  if (deps.canShareFiles([file])) {
    try {
      await deps.share({ files: [file] });
      return { ok: true, via: "share" };
    } catch (error) {
      // Dismissing the sheet is a completed interaction, not a failure — and
      // falling through to a second save would be a surprising thing to do to
      // someone who just said no.
      if (error instanceof Error && error.name === "AbortError") {
        return { ok: true, via: "share" };
      }
      // Anything else — most likely `NotAllowedError`, because iOS wants the
      // share to sit inside a user gesture and the `await` above may have
      // outlived it — falls through to the blob save below rather than
      // reporting a failure. One of the two usually works.
    }
  }

  deps.saveBlob(blob, filename);
  return { ok: true, via: "blob" };
}

/**
 * The real dependencies. Separated from `saveExport` so the logic above has no
 * direct DOM or `navigator` reference.
 *
 * **Every platform method here is WRAPPED, never handed over as a bare
 * reference.** `fetchImpl: fetch` reads fine and is a real bug: `saveExport`
 * calls it as `deps.fetchImpl(...)`, which makes `this` the deps object, and
 * WebKit enforces the receiver on `Window.fetch` — *"Can only call
 * Window.fetch on instances of Window"*. Chrome, Firefox and Node are lenient
 * about it, so it fails on exactly one platform and nowhere a test would
 * ordinarily look.
 *
 * That is the trap in this whole seam, and it is worth naming: the injection
 * boundary exists so the routing logic can be tested without a browser, which
 * means the one line that actually touches the browser is the one line the
 * tests never execute. Everything below is a closure for that reason, not for
 * style.
 */
export function browserSaveDeps(): SaveDeps {
  return {
    fetchImpl: (input, init) => fetch(input, init),
    installed: isInstalledApp(),
    canShareFiles: (files) => {
      const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean };
      return typeof nav.canShare === "function" && typeof nav.share === "function"
        ? nav.canShare({ files })
        : false;
    },
    share: (data) => navigator.share(data),
    openTab: (url) => {
      // An anchor rather than `window.open`: passing `noopener` in the
      // features string makes `open` return null BY SPEC, so a blocked popup
      // and a successful one are indistinguishable and any "did it work?"
      // fallback fires every time, downloading twice. `rel="noopener"` on an
      // anchor still denies the new context a handle back into this app.
      //
      // No `download` attribute: the filename comes from the server's
      // `Content-Disposition`, and `download` would override it with the URL's
      // last segment.
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
    },
    saveBlob: (blob, filename) => {
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      // Here the `download` attribute IS wanted: a blob URL has no name of its
      // own, so without it the file is saved as a UUID.
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      // Revoked on the next tick rather than immediately — Safari reads the
      // blob asynchronously after the click, and revoking synchronously
      // produces an empty file.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    },
  };
}
