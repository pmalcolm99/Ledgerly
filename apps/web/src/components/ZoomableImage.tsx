"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { RotateCw, ZoomIn, ZoomOut } from "lucide-react";

/**
 * Receipt image with zoom and rotate (brief §5).
 *
 * `isolate-stack` (isolation: isolate) is task 7.12's requirement applied
 * where it actually matters. The transforms below create their own layers,
 * and this is the one component on the page capable of painting over a modal.
 * Trapping the stacking context here means the delete-confirmation dialog
 * cannot end up behind a rotated receipt — the shape of the Leaflet bug
 * FORKD_LESSONS.md records, minus Leaflet.
 *
 * Zoom is a plain scale transform inside an overflow-auto box rather than a
 * pinch-zoom implementation: the browser's own pinch already works on a
 * scrollable overflowing image, and reimplementing it badly is worse than not
 * reimplementing it.
 */
const ZOOM_STEPS = [1, 1.5, 2, 3] as const;

export function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const [zoomIndex, setZoomIndex] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [failed, setFailed] = useState(false);

  const zoom = ZOOM_STEPS[zoomIndex]!;

  if (failed) {
    return (
      <div className="flex h-48 items-center justify-center rounded-xl border border-divider bg-content2 text-sm text-default-500">
        The image isn&apos;t ready yet.
      </div>
    );
  }

  return (
    <div className="isolate-stack flex flex-col gap-2">
      <div className="max-h-[60dvh] overflow-auto rounded-xl border border-divider bg-content2">
        {/* A plain <img>, not next/image: receipt images come from an
            authenticated route that re-derives the path server-side (D-23).
            Sending them through Next's optimizer would proxy private images
            through a cache with no notion of who may see them. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          onError={() => setFailed(true)}
          className="mx-auto origin-center transition-transform duration-150"
          style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
        />
      </div>
      <div className="flex items-center gap-1">
        <Button
          isIconOnly
          size="sm"
          variant="flat"
          aria-label="Zoom out"
          isDisabled={zoomIndex === 0}
          onPress={() => setZoomIndex((index) => Math.max(0, index - 1))}
        >
          <ZoomOut className="h-4 w-4" />
        </Button>
        <Button
          isIconOnly
          size="sm"
          variant="flat"
          aria-label="Zoom in"
          isDisabled={zoomIndex === ZOOM_STEPS.length - 1}
          onPress={() => setZoomIndex((index) => Math.min(ZOOM_STEPS.length - 1, index + 1))}
        >
          <ZoomIn className="h-4 w-4" />
        </Button>
        <Button
          isIconOnly
          size="sm"
          variant="flat"
          aria-label="Rotate 90 degrees"
          onPress={() => setRotation((current) => (current + 90) % 360)}
        >
          <RotateCw className="h-4 w-4" />
        </Button>
        <span className="ml-1 text-xs text-default-400 tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
      </div>
    </div>
  );
}
