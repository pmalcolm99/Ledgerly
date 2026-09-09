"use client";

import NextLink from "next/link";
import { useState } from "react";
import { formatMoneyDisplay } from "@ledgerly/shared/moneyDisplay";
import { Receipt as ReceiptIcon } from "lucide-react";

import { formatDate } from "../lib/dates";
import { receiptImageUrl } from "../lib/images";
import { ReviewBadge } from "./ReviewBadge";
import { receiptReviewState } from "../lib/receiptLabels";

export type ReceiptRowData = {
  id: string;
  merchantName: string | null;
  transactionDate: string | null;
  total: string | null;
  currency: string;
  extractionStatus: string;
  missingFields: readonly string[];
  validationFlags?: readonly string[];
  thumbKey: string | null;
  projectName?: string;
};

/**
 * One row of the receipt list: thumbnail, merchant, date, total, and a review
 * badge when anything is outstanding.
 *
 * The thumbnail is an authenticated route that 404s until ingest has written
 * the render, so `thumbKey` being null is the normal state for a few seconds
 * after upload — the icon placeholder is the expected view, not an error. A
 * load failure falls back to the same placeholder rather than a broken image.
 */
export function ReceiptRow({ receipt }: { receipt: ReceiptRowData }) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const state = receiptReviewState(receipt);
  const showThumb = receipt.thumbKey !== null && !thumbFailed;

  return (
    <NextLink
      href={`/receipts/${receipt.id}`}
      className="flex items-center gap-3 rounded-xl border border-divider bg-content1 p-3 transition-colors hover:bg-content2"
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-content3">
        {showThumb ? (
          // A plain <img>, not next/image — see ZoomableImage.tsx.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={receiptImageUrl(receipt.id, "thumb")}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <ReceiptIcon className="h-5 w-5 text-default-400" aria-hidden />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          {receipt.merchantName ?? <span className="text-default-400">Merchant not read</span>}
        </p>
        <p className="text-xs text-default-500">
          {formatDate(receipt.transactionDate)}
          {receipt.projectName ? ` · ${receipt.projectName}` : ""}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="font-semibold tabular-nums">
          {formatMoneyDisplay(receipt.total, { currency: receipt.currency })}
        </span>
        {state !== "clear" ? (
          <ReviewBadge
            state={state}
            count={receipt.missingFields.length + (receipt.validationFlags?.length ?? 0)}
          />
        ) : null}
      </div>
    </NextLink>
  );
}
