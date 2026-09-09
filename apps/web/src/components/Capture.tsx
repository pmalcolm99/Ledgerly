"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, CardBody, Progress } from "@heroui/react";
import { AlertTriangle, Camera, Check, Images, Loader2 } from "lucide-react";

import { trpc } from "../lib/trpc";
import { mapWithConcurrency, uploadOneFile } from "../lib/upload";

/**
 * apps/web/src/components/Capture.tsx — receipt capture (task 7.8, brief §4).
 *
 * The loudest thing on the dashboard, because the actual use is standing in a
 * parking lot with a receipt in one hand.
 *
 * TWO inputs, not one. `capture="environment"` does not mean "prefer the
 * camera" on iOS — it means "the camera is the ONLY source", and Safari drops
 * the Photo Library and Files options from the sheet entirely. A single input
 * carrying it can therefore never reach an existing photo or a PDF, which is
 * most of what a receipt actually is by the time you sit down to file them.
 *
 * So: one input with `capture` behind "Take photo", and one without it behind
 * "Choose files", which accepts images AND `application/pdf` (the ingest
 * pipeline has rasterised PDFs since Phase 5 — D-10 — it was only ever the
 * `accept` attribute keeping them out of the picker).
 *
 * OPTIMISTIC UI, AND IT HANDS OVER. A card appears the instant files are
 * chosen, showing a local object-URL preview — the user never waits on a round
 * trip to see that their photo registered. The card's job ends the moment the
 * real row exists: once the upload returns and `receipts.list` has refetched,
 * the entry is retired and the row below takes over, carrying its own
 * `ReviewBadge` that says "Reading…", then "Complete" or "Needs review", and
 * that updates itself because the dashboard polls while anything is pending.
 *
 * It did NOT used to hand over, and that was a visible bug: a successful
 * upload's card sat there spinning "Reading the receipt…" for the life of the
 * tab, directly above a row that had already finished and filled in. Nothing
 * ever removed it — only the error branch's Dismiss button could — so the one
 * element still claiming work was in progress was the one element with no way
 * to learn otherwise. Two things on screen described the same receipt and only
 * one of them was right.
 *
 * A failed upload's card stays, because nothing else represents it: there is
 * no row to hand over to. That one is dismissed by hand.
 */

const UPLOAD_CONCURRENCY = 3;

type Pending = {
  key: string;
  filename: string;
  previewUrl: string;
  progress: number;
  receiptId: string | null;
  error: string | null;
};

export function Capture({ projectId }: { projectId: string }) {
  const [pending, setPending] = useState<Pending[]>([]);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const utils = trpc.useUtils();

  /**
   * Every object URL created in this session, tracked in a ref.
   *
   * A ref, not the `pending` state, and this is a real bug rather than a
   * style point: an unmount-only cleanup closes over the value `pending` had
   * on the FIRST render, which is the empty array — so a cleanup written that
   * way revokes nothing at all and leaks a few MB of blob per photo for the
   * life of the tab. The ref is mutable and always current, so teardown sees
   * every URL actually created.
   */
  const objectUrls = useRef<string[]>([]);

  useEffect(() => {
    const urls = objectUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  // The extraction poll used to live here and has moved to ProjectDashboard,
  // which owns the `receipts.list` query this screen actually renders. Two
  // bugs came from it being here:
  //
  //  - It polled `{ projectId, limit: 50 }` while the dashboard renders
  //    `{ projectId, ...filters, limit: 50 }`. With no filters set those keys
  //    hash identically so it happened to work; the moment ANY filter was
  //    active it refreshed a different cache entry than the one on screen.
  //  - Its stop condition was "the pending list is empty", but entries are
  //    only removed by the error branch's Dismiss button. A successful upload
  //    therefore left the 2.5s interval running for the life of the tab.
  //
  // Polling now belongs to the query that renders the rows, keyed on whether
  // any visible row is still extracting. See lib/extractionPolling.ts.

  /**
   * Retires the optimistic cards for uploads that succeeded, once their rows
   * are on screen.
   *
   * The revokes happen OUTSIDE the state updater. A `setState` updater must be
   * pure — React may invoke it more than once for a single update, and in
   * StrictMode reliably does — so revoking a blob URL inside one would fire
   * twice and, worse, would run even for an update React later discards.
   */
  const retireUploaded = useCallback((retiring: { key: string; previewUrl: string }[]) => {
    if (retiring.length === 0) return;
    const keys = new Set(retiring.map((item) => item.key));
    setPending((current) => current.filter((item) => !keys.has(item.key)));

    for (const { previewUrl } of retiring) URL.revokeObjectURL(previewUrl);
    const revoked = new Set(retiring.map((item) => item.previewUrl));
    objectUrls.current = objectUrls.current.filter((url) => !revoked.has(url));
  }, []);

  const onFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const chosen = Array.from(files);

      const started: Pending[] = chosen.map((file, index) => {
        const previewUrl = URL.createObjectURL(file);
        objectUrls.current.push(previewUrl);
        return {
          key: `${Date.now()}-${index}-${file.name}`,
          filename: file.name || "photo",
          previewUrl,
          progress: 0,
          receiptId: null,
          error: null,
        };
      });
      setPending((current) => [...started, ...current]);

      // Collected here rather than read back off `pending` afterwards: the
      // outcome is known at this point, and a later read of state would race a
      // second batch started in the meantime.
      const uploaded: { key: string; previewUrl: string }[] = [];

      await mapWithConcurrency(chosen, UPLOAD_CONCURRENCY, async (file, index) => {
        const entry = started[index]!;
        const key = entry.key;
        const outcome = await uploadOneFile(file, projectId, (fraction) => {
          setPending((current) =>
            current.map((item) => (item.key === key ? { ...item, progress: fraction } : item)),
          );
        });
        if (outcome.ok) uploaded.push({ key, previewUrl: entry.previewUrl });
        setPending((current) =>
          current.map((item) =>
            item.key === key
              ? outcome.ok
                ? { ...item, receiptId: outcome.receiptId, progress: 1 }
                : { ...item, error: outcome.error }
              : item,
          ),
        );
      });

      // The list now has rows the server knows about. Awaited before retiring
      // the cards — `invalidate()` resolves once the refetch has landed, so the
      // row is in the cache before its stand-in disappears and there is no
      // frame where the receipt is represented by nothing at all.
      await utils.receipts.list.invalidate({ projectId });
      retireUploaded(uploaded);

      await utils.projects.list.invalidate();
      await utils.projects.stats.invalidate({ projectId });
    },
    [projectId, retireUploaded, utils],
  );

  function dismiss(key: string) {
    setPending((current) => {
      const target = current.find((item) => item.key === key);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
        objectUrls.current = objectUrls.current.filter((url) => url !== target.previewUrl);
      }
      return current.filter((item) => item.key !== key);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Card shadow="sm" className="border-2 border-dashed border-primary-300 bg-primary-50/40">
        <CardBody className="items-center gap-3 p-6">
          {/* No form around either input — this posts via XHR, and a form
              would add a submit target that does nothing. */}
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="sr-only"
            onChange={(event) => {
              void onFiles(event.target.files);
              // Reset so choosing the same file twice still fires onChange.
              event.target.value = "";
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            // No `capture` here — that is the whole point of the second
            // input. `application/pdf` is listed explicitly because
            // `image/*` excludes it, and iOS matches the Files picker against
            // this list.
            accept="image/*,application/pdf,.pdf,.heic,.heif"
            multiple
            className="sr-only"
            onChange={(event) => {
              void onFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <div className="flex w-full flex-col gap-2 sm:flex-row">
            <Button
              color="primary"
              size="lg"
              className="h-14 flex-1 text-base"
              startContent={<Camera className="h-5 w-5" />}
              onPress={() => cameraInputRef.current?.click()}
            >
              Take photo
            </Button>
            <Button
              variant="flat"
              size="lg"
              className="h-14 flex-1 text-base"
              startContent={<Images className="h-5 w-5" />}
              onPress={() => fileInputRef.current?.click()}
            >
              Choose files
            </Button>
          </div>
          <p className="text-center text-xs text-default-500">
            Photos, or PDFs. Pick several at once — the first page of a PDF is used.
          </p>
        </CardBody>
      </Card>

      {pending.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Uploads in progress">
          {pending.map((item) => (
            <li key={item.key}>
              <Card shadow="none" className="border border-divider">
                <CardBody className="flex-row items-center gap-3 p-3">
                  {/* A local object-URL preview, so next/image is not even
                      applicable. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.previewUrl}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.filename}</p>
                    {item.error ? (
                      <p className="flex items-center gap-1 text-xs text-danger">
                        <AlertTriangle className="h-3 w-3" aria-hidden />
                        {item.error}
                      </p>
                    ) : item.receiptId ? (
                      <p className="flex items-center gap-1 text-xs text-default-500">
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                        Reading the receipt…
                      </p>
                    ) : (
                      <Progress
                        aria-label={`Uploading ${item.filename}`}
                        size="sm"
                        value={item.progress * 100}
                        className="mt-1"
                      />
                    )}
                  </div>
                  {item.error ? (
                    <Button size="sm" variant="light" onPress={() => dismiss(item.key)}>
                      Dismiss
                    </Button>
                  ) : item.receiptId ? (
                    <Check className="h-4 w-4 text-success" aria-hidden />
                  ) : (
                    <span className="text-xs tabular-nums text-default-500">
                      {Math.round(item.progress * 100)}%
                    </span>
                  )}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
