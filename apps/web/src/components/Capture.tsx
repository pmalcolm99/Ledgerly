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
 * OPTIMISTIC UI. A card appears the instant files are chosen, showing a local
 * object-URL preview — the user never waits on a round trip to see that their
 * photo registered. As each upload returns a receiptId the card binds to the
 * real row, and a poll then watches those rows until extraction finishes.
 * The local preview is kept until the server thumbnail actually loads, because
 * `/api/images/<id>/thumb` 404s until ingest has written the render — binding
 * to it eagerly would flash a broken image on every upload.
 */

const UPLOAD_CONCURRENCY = 3;
const POLL_INTERVAL_MS = 2500;

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

  const awaitingExtraction = pending
    .filter((item) => item.receiptId && !item.error)
    .map((item) => item.receiptId!);

  // Poll only while something is actually in flight, and stop the moment the
  // list empties — a permanent interval on a dashboard over a tunnel is a
  // real battery and bandwidth cost.
  trpc.receipts.list.useQuery(
    { projectId, limit: 50 },
    {
      refetchInterval: awaitingExtraction.length > 0 ? POLL_INTERVAL_MS : false,
      enabled: awaitingExtraction.length > 0,
    },
  );

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

      await mapWithConcurrency(chosen, UPLOAD_CONCURRENCY, async (file, index) => {
        const key = started[index]!.key;
        const outcome = await uploadOneFile(file, projectId, (fraction) => {
          setPending((current) =>
            current.map((item) => (item.key === key ? { ...item, progress: fraction } : item)),
          );
        });
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

      // The list now has rows the server knows about.
      await utils.receipts.list.invalidate({ projectId });
      await utils.projects.list.invalidate();
      await utils.projects.stats.invalidate({ projectId });
    },
    [projectId, utils],
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
