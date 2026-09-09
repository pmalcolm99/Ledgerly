"use client";

import NextLink from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button, Card, CardBody, Kbd, Skeleton } from "@heroui/react";
import { CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";

import { trpc } from "../lib/trpc";
import { receiptImageUrl } from "../lib/images";
import { missingFieldLabel, validationFlagLabel } from "../lib/receiptLabels";
import { EditableField } from "./EditableField";
import type { MissingFieldToken } from "@ledgerly/shared/receiptFields";

/**
 * apps/web/src/components/ReviewQueue.tsx — brief §6.
 *
 * Every receipt with outstanding fields, across every project the user can
 * read, "optimised for fast keyboard entry: fix a field, next receipt".
 *
 * So it is one receipt at a time rather than a list: a list makes you aim at
 * things. Here the next receipt is already on screen, the first empty field is
 * focused, Enter commits, and ⌘/Ctrl+Enter moves on. The image sits beside the
 * fields because the whole task is copying from one to the other.
 *
 * Note the queue's predicate is `missing_fields <> '{}' OR extraction_status
 * <> 'ok'` — a receipt with unread fields but clean arithmetic is still 'ok',
 * and is the most common thing in here.
 */
export function ReviewQueue() {
  const [index, setIndex] = useState(0);
  const utils = trpc.useUtils();
  const queue = trpc.receipts.reviewQueue.useQuery({ limit: 50 });

  const items = useMemo(() => queue.data?.items ?? [], [queue.data]);
  const current = items[index];

  const detail = trpc.receipts.get.useQuery(
    { id: current?.id ?? "" },
    { enabled: Boolean(current) },
  );

  const update = trpc.receipts.update.useMutation({
    onSuccess: async () => {
      if (current) await utils.receipts.get.invalidate({ id: current.id });
    },
  });
  const dismiss = trpc.receipts.dismissMissingField.useMutation({
    onSuccess: async () => {
      if (current) await utils.receipts.get.invalidate({ id: current.id });
    },
  });

  const goNext = () => setIndex((value) => Math.min(value + 1, Math.max(items.length - 1, 0)));
  const goPrev = () => setIndex((value) => Math.max(value - 1, 0));

  // Cmd/Ctrl+Enter advances without leaving the keyboard. Plain Enter is left
  // to the field itself (it commits and blurs), so the two don't fight.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        goNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The <h1> renders in EVERY state — loading, error, empty and populated.
  // A page whose title appears only once its data arrives has no identity
  // while it is loading and none at all when it fails, which is both worse
  // for a screen reader and worse for anyone watching a slow connection.
  if (queue.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold">Review</h1>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (queue.isError) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold">Review</h1>
        <Card>
          <CardBody className="gap-2 p-5">
            <p className="font-semibold">Couldn&apos;t load the review queue.</p>
            <p className="text-sm text-default-500">{queue.error.message}</p>
          </CardBody>
        </Card>
      </div>
    );
  }

  // An empty queue is a success state, not an error state (task 7.5).
  if (items.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold">Review</h1>
        <Card shadow="sm">
          <CardBody className="items-center gap-3 p-10 text-center">
            <CheckCircle2 className="h-10 w-10 text-success" aria-hidden />
            <p className="text-lg font-semibold">Nothing needs review</p>
            <p className="max-w-sm text-sm text-default-500">
              Every receipt you can see has been read completely. New uploads will appear here if
              anything couldn&apos;t be read.
            </p>
            <Button as={NextLink} href="/" size="sm" variant="flat">
              Back to projects
            </Button>
          </CardBody>
        </Card>
      </div>
    );
  }

  const receipt = detail.data?.receipt;
  const missing = receipt ? receipt.missingFields : (current?.missingFields ?? []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Review</h1>
          <p className="text-sm text-default-500">
            {index + 1} of {items.length}
            {current?.projectName ? ` · ${current.projectName}` : ""}
            {current && !current.canEdit ? " · view only" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            isIconOnly
            size="sm"
            variant="flat"
            aria-label="Previous receipt"
            isDisabled={index === 0}
            onPress={goPrev}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="flat"
            endContent={<ChevronRight className="h-4 w-4" />}
            isDisabled={index >= items.length - 1}
            onPress={goNext}
          >
            Next
          </Button>
          <span className="hidden items-center gap-1 text-xs text-default-400 sm:flex">
            <Kbd keys={["command"]}>Enter</Kbd>
          </span>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="max-h-[60dvh] overflow-auto rounded-xl border border-divider bg-content2">
          {current ? (
            // A plain <img>, not next/image — see ZoomableImage.tsx.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={receiptImageUrl(current.id, "display")} alt="Receipt" className="mx-auto" />
          ) : null}
        </div>

        <div className="flex flex-col gap-3">
          {current && receipt ? (
            <>
              {receipt.validationFlags.length > 0 ? (
                <div className="rounded-lg border border-warning-200 bg-warning-50/50 p-3 text-sm">
                  {receipt.validationFlags.map((flag) => (
                    <p key={flag}>{validationFlagLabel(flag)}</p>
                  ))}
                </div>
              ) : null}

              {missing.length === 0 ? (
                <div className="rounded-lg border border-success-200 bg-success-50/50 p-3 text-sm">
                  Nothing outstanding on this one.
                </div>
              ) : null}

              {/* Only the outstanding fields, in the pipeline's own order.
                  Showing all eighteen would defeat the point of a queue. */}
              {missing
                // Excludes `items` (no single control) and, deliberately, any
                // token this build does not know about: a pipeline that grows a
                // twelfth token should render one fewer field here, not crash on
                // an undefined mapping.
                .filter(
                  (token): token is Exclude<MissingFieldToken, "items"> =>
                    token !== "items" && token in TOKEN_TO_COLUMN,
                )
                .map((token, position) => (
                  <ReviewField
                    key={token}
                    token={token}
                    receiptId={current.id}
                    receipt={receipt}
                    autoFocus={position === 0}
                    canEdit={current.canEdit}
                    isSaving={update.isPending}
                    onSave={(column, next) => update.mutate({ id: current.id, [column]: next })}
                    onDismiss={() => dismiss.mutate({ id: current.id, field: token })}
                  />
                ))}

              {missing.includes("items") ? (
                <p className="text-sm text-default-500">
                  No line items were read.{" "}
                  <NextLink href={`/receipts/${current.id}`} className="text-primary underline">
                    Add them on the receipt page
                  </NextLink>
                  .
                </p>
              ) : null}

              {update.isError ? (
                <p className="rounded bg-danger-50 p-3 text-sm text-danger">
                  {update.error.message}
                </p>
              ) : null}

              <Button
                as={NextLink}
                href={`/receipts/${current.id}`}
                size="sm"
                variant="light"
                className="self-start"
              >
                Open full receipt
              </Button>
            </>
          ) : (
            <Skeleton className="h-48 rounded-xl" />
          )}
        </div>
      </div>
    </div>
  );
}

/** Maps a missing-field token onto the column it edits and the right input
 *  type. `items` never reaches here — it has no single control. */
const TOKEN_TO_COLUMN: Record<
  Exclude<MissingFieldToken, "items">,
  { column: string; type: "text" | "date" | "time" | "decimal" }
> = {
  merchant_name: { column: "merchantName", type: "text" },
  merchant_address: { column: "merchantAddress", type: "text" },
  merchant_phone: { column: "merchantPhone", type: "text" },
  transaction_date: { column: "transactionDate", type: "date" },
  transaction_time: { column: "transactionTime", type: "time" },
  subtotal: { column: "subtotal", type: "decimal" },
  sales_tax: { column: "salesTax", type: "decimal" },
  total: { column: "total", type: "decimal" },
  card_last4: { column: "cardLast4", type: "text" },
  payment_method: { column: "paymentMethod", type: "text" },
};

function ReviewField({
  token,
  receipt,
  autoFocus,
  canEdit,
  isSaving,
  onSave,
  onDismiss,
}: {
  token: Exclude<MissingFieldToken, "items">;
  receiptId: string;
  receipt: Record<string, unknown>;
  autoFocus: boolean;
  canEdit: boolean;
  isSaving: boolean;
  onSave: (column: string, next: string | null) => void;
  onDismiss: () => void;
}) {
  const mapping = TOKEN_TO_COLUMN[token];
  const value = receipt[mapping.column];

  return (
    <div data-autofocus={autoFocus ? "true" : undefined}>
      <EditableField
        label={missingFieldLabel(token)}
        type={mapping.type}
        value={typeof value === "string" ? value : null}
        // The queue is gated at "read" on purpose, so a read-only member sees
        // it for context. Without threading this through, they got fully
        // editable inputs and every save failed with NOT_FOUND.
        canEdit={canEdit}
        isMissing
        isDismissed={false}
        isSaving={isSaving}
        onSave={(next) => onSave(mapping.column, next)}
        onDismiss={onDismiss}
      />
    </div>
  );
}
