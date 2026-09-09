/**
 * apps/web/src/lib/upload.ts — the upload transport (task 7.8).
 *
 * XMLHttpRequest, not fetch, and that is the whole reason this file exists:
 * `fetch` cannot report upload progress. There is no request-body progress
 * event in the Fetch standard that ships across browsers, and `xhr.upload
 * .onprogress` is the only way to draw a real per-file progress bar. On a
 * phone uploading a 5 MB photo over a tunnel, "47%" and "spinning" are very
 * different experiences.
 *
 * One file per request, three at a time. The endpoint accepts a batch, but a
 * batch gives one progress number for the whole set; one request per file is
 * what makes the bars per-file. Each still costs 1 against
 * UPLOAD_RATE_LIMIT_PER_MIN (default 60), and the brief's "10 photos in one
 * action" is one *user* action, which this is.
 */

export type UploadOutcome =
  { ok: true; receiptId: string } | { ok: false; error: string; retryAfterSeconds?: number };

/** Per-file error constants the route returns inside a 200, plus the
 *  whole-request ones. The route is inconsistent about case (SCREAMING_SNAKE
 *  per-file, snake_case for request-level), so both are mapped here. */
const UPLOAD_ERROR_LABELS: Record<string, string> = {
  FILE_TOO_LARGE: "That file is too large.",
  UNRECOGNIZED_OR_MISLABELED_TYPE: "That file isn't an image or PDF we can read.",
  PDF_PAGE_TOO_LARGE: "That PDF's page is too large.",
  PDF_UNREADABLE: "That PDF couldn't be read.",
  IMAGE_TOO_LARGE_MEGAPIXELS: "That image is too large.",
  INTERNAL_ERROR: "The server couldn't save it. Try again.",
  REQUEST_TOO_LARGE: "That file is too large.",
  TOO_MANY_FILES: "Too many files at once.",
  BATCH_EXCEEDS_RATE_LIMIT: "Too many files at once.",
  invalid_multipart_body: "The upload was malformed. Try again.",
  projectId_required: "Something went wrong identifying the project.",
  no_files: "No file was sent.",
  not_found: "You can't add receipts to this project.",
  onboarding_required: "Finish setting up your account first.",
  rate_limited: "Too many uploads just now.",
};

export function uploadErrorLabel(error: string): string {
  return UPLOAD_ERROR_LABELS[error] ?? "Upload failed.";
}

export function uploadOneFile(
  file: File,
  projectId: string,
  onProgress: (fraction: number) => void,
): Promise<UploadOutcome> {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append("projectId", projectId);
    form.append("files", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/receipts/upload");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };

    xhr.onload = () => {
      // The route answers 200 even when every file in it failed; the real
      // outcome is per-entry inside `results`.
      if (xhr.status === 200) {
        try {
          const body = JSON.parse(xhr.responseText) as {
            results?: Array<{ ok: boolean; receiptId?: string; error?: string }>;
          };
          const first = body.results?.[0];
          if (first?.ok && first.receiptId) {
            onProgress(1);
            resolve({ ok: true, receiptId: first.receiptId });
            return;
          }
          resolve({ ok: false, error: uploadErrorLabel(first?.error ?? "INTERNAL_ERROR") });
        } catch {
          resolve({ ok: false, error: "The server sent something unreadable." });
        }
        return;
      }

      if (xhr.status === 429) {
        const retryAfter = Number(xhr.getResponseHeader("retry-after"));
        resolve({
          ok: false,
          error: uploadErrorLabel("rate_limited"),
          retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
        });
        return;
      }

      // 403 from the Access perimeter is plain text, not JSON.
      if (xhr.status === 403) {
        resolve({ ok: false, error: "Your session expired. Reload the page." });
        return;
      }

      try {
        const body = JSON.parse(xhr.responseText) as { error?: string };
        resolve({ ok: false, error: uploadErrorLabel(body.error ?? "INTERNAL_ERROR") });
      } catch {
        resolve({ ok: false, error: "Upload failed." });
      }
    };

    xhr.onerror = () => resolve({ ok: false, error: "Lost connection during upload." });
    xhr.onabort = () => resolve({ ok: false, error: "Upload cancelled." });

    xhr.send(form);
  });
}

/** Runs `worker` over `items` with at most `limit` in flight. Sequential
 *  would be slow for a camera-roll import; unbounded would spike memory and
 *  trip the rate limiter in one burst. */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
}
