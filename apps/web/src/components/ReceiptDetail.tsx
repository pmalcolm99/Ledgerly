"use client";

import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Button,
  Card,
  CardBody,
  Chip,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Skeleton,
  Textarea,
} from "@heroui/react";
import { AlertTriangle, ArrowLeft, Check, RefreshCw, Trash2 } from "lucide-react";
import type { EditableReceiptColumn, MissingFieldToken } from "@ledgerly/shared/receiptFields";
import { isValidationFlag } from "@ledgerly/shared/receiptValidation";

import { trpc } from "../lib/trpc";
import { EmailReceiptButton } from "./EmailReceiptButton";
import { extractionRefetchInterval } from "../lib/extractionPolling";
import { receiptImageUrl } from "../lib/images";
import {
  EXTRACTION_FAILED_HINT,
  extractionErrorLabel,
  validationFlagLabel,
} from "../lib/receiptLabels";
import { EditableField } from "./EditableField";
import { LineItems } from "./LineItems";
import { ZoomableImage } from "./ZoomableImage";

/**
 * apps/web/src/components/ReceiptDetail.tsx — brief §5.
 *
 * Every extracted field is editable, missing ones are highlighted with a
 * fill-or-dismiss affordance, line items are a table, and delete is the only
 * way a receipt image is ever removed.
 */
export function ReceiptDetail({ receiptId }: { receiptId: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [isDeleteOpen, setDeleteOpen] = useState(false);

  // Poll while extraction is still running, stop when it lands. Without
  // this the page fetched once and never learned the result — the reported
  // "fields don't populate until you tap re-extract" bug. See
  // lib/extractionPolling.ts for why re-extract only appeared to fix it.
  const query = trpc.receipts.get.useQuery(
    { id: receiptId },
    {
      refetchInterval: (q) => extractionRefetchInterval([q.state.data?.receipt.extractionStatus]),
    },
  );

  const invalidate = async () => {
    await utils.receipts.get.invalidate({ id: receiptId });
  };

  const update = trpc.receipts.update.useMutation({ onSuccess: invalidate });
  const dismiss = trpc.receipts.dismissMissingField.useMutation({ onSuccess: invalidate });
  const undismiss = trpc.receipts.undismissMissingField.useMutation({ onSuccess: invalidate });
  const acknowledge = trpc.receipts.acknowledgeValidationFlag.useMutation({
    onSuccess: invalidate,
  });
  const unacknowledge = trpc.receipts.unacknowledgeValidationFlag.useMutation({
    onSuccess: invalidate,
  });
  const reextract = trpc.receipts.reextract.useMutation({ onSuccess: invalidate });
  const remove = trpc.receipts.delete.useMutation({
    onSuccess: async () => {
      await utils.receipts.list.invalidate();
      router.replace(projectId ? `/projects/${projectId}` : "/");
    },
  });

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-40 rounded-lg" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Card>
        <CardBody className="gap-2 p-5">
          <p className="font-semibold">Couldn&apos;t load this receipt.</p>
          <p className="text-sm text-default-500">{query.error.message}</p>
          <Button as={NextLink} href="/" size="sm" className="self-start">
            Back to projects
          </Button>
        </CardBody>
      </Card>
    );
  }

  const { receipt, project, uploader, items, permissions } = query.data;
  const projectId = project.id;
  const canEdit = permissions.canEdit;
  const missing = new Set(receipt.missingFields);
  const dismissed = new Set(receipt.dismissedFields);

  // Which column the in-flight `update` is for, so only THAT field disables
  // while it saves. `isSaving={update.isPending}` was passed to all twelve,
  // which meant correcting one value froze the entire form until the round
  // trip returned — over a tunnel, long enough to feel broken.
  // `update.variables` is the last input, whose non-`id` key is the column.
  const savingColumn = update.variables
    ? Object.keys(update.variables).find((key) => key !== "id")
    : undefined;

  // `tip` is the one editable money column with no missing-field token, so
  // the column type is the token map's keys plus it.
  const field = (
    label: string,
    column: EditableReceiptColumn | "tip",
    token: MissingFieldToken | null,
    type: "text" | "date" | "time" | "decimal" = "text",
  ) => (
    <EditableField
      key={column}
      label={label}
      type={type}
      value={receipt[column]}
      canEdit={canEdit}
      isMissing={token !== null && missing.has(token)}
      isDismissed={token !== null && dismissed.has(token)}
      isSaving={update.isPending && savingColumn === column}
      onSave={(next) => update.mutate({ id: receiptId, [column]: next })}
      onDismiss={token ? () => dismiss.mutate({ id: receiptId, field: token }) : undefined}
      onUndismiss={token ? () => undismiss.mutate({ id: receiptId, field: token }) : undefined}
    />
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <Button
          as={NextLink}
          href={`/projects/${projectId}`}
          size="sm"
          variant="light"
          startContent={<ArrowLeft className="h-4 w-4" />}
        >
          {project.name}
        </Button>
      </div>

      {receipt.extractionStatus === "failed" ? (
        <Card className="border border-danger-200 bg-danger-50/50" shadow="none">
          <CardBody className="gap-1 p-4">
            <p className="flex items-center gap-2 font-medium text-danger">
              <AlertTriangle className="h-4 w-4" aria-hidden />
              {extractionErrorLabel(receipt.extractionError)}
            </p>
            <p className="text-sm text-default-600">{EXTRACTION_FAILED_HINT}</p>
          </CardBody>
        </Card>
      ) : null}

      {receipt.validationFlags.length > 0 ? (
        <Card className="border border-warning-200 bg-warning-50/50" shadow="none">
          <CardBody className="gap-2 p-4">
            {receipt.validationFlags.map((flag) => (
              <div key={flag} className="flex items-center gap-2 text-sm">
                <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
                <span className="min-w-0 flex-1">{validationFlagLabel(flag)}</span>
                {/*
                  Until this button existed a flag could only be cleared by
                  editing the numbers until they agreed — which, on a receipt
                  that genuinely does not reconcile (a discount the model
                  applied twice), means inventing a line item that is not on the
                  paper. The receipt sat in the review queue permanently with a
                  warning nobody could act on.
                */}
                {canEdit && isValidationFlag(flag) ? (
                  <Button
                    size="sm"
                    variant="light"
                    className="shrink-0"
                    isLoading={acknowledge.isPending && acknowledge.variables?.flag === flag}
                    onPress={() => acknowledge.mutate({ id: receiptId, flag })}
                  >
                    That&apos;s correct
                  </Button>
                ) : null}
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {receipt.acknowledgedFlags.length > 0 ? (
        <Card className="border border-divider" shadow="none">
          <CardBody className="gap-2 p-4">
            {receipt.acknowledgedFlags.map((flag) => (
              <div key={flag} className="flex items-center gap-2 text-sm text-default-500">
                <Check className="h-4 w-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">{validationFlagLabel(flag)} — marked correct</span>
                {/* Recoverable, for the same reason `undismissMissingField`
                    exists: an acknowledgement made by mistake must not be a
                    one-way door. The flag only comes back if the numbers still
                    fail the check — the server's recompute decides that. */}
                {canEdit && isValidationFlag(flag) ? (
                  <Button
                    size="sm"
                    variant="light"
                    className="shrink-0"
                    isLoading={unacknowledge.isPending && unacknowledge.variables?.flag === flag}
                    onPress={() => unacknowledge.mutate({ id: receiptId, flag })}
                  >
                    Undo
                  </Button>
                ) : null}
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <ZoomableImage
            src={receiptImageUrl(receiptId, "display")}
            alt={`Receipt from ${receipt.merchantName ?? "an unread merchant"}`}
          />
          <p className="text-xs text-default-400">
            Added by {uploader?.name ?? "someone no longer on this instance"}
            {receipt.extractionModel ? ` · read by ${receipt.extractionModel}` : ""}
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {field("Merchant", "merchantName", "merchant_name")}
          {field("Address", "merchantAddress", "merchant_address")}
          {field("Phone", "merchantPhone", "merchant_phone")}
          <div className="grid grid-cols-2 gap-3">
            {field("Date", "transactionDate", "transaction_date", "date")}
            {field("Time", "transactionTime", "transaction_time", "time")}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {field("Subtotal", "subtotal", "subtotal", "decimal")}
            {field("Sales tax", "salesTax", "sales_tax", "decimal")}
            {/* `tip` is never in missing_fields — most receipts have none, so
                the pipeline never reports it as missing. */}
            {field("Tip", "tip", null, "decimal")}
            {field("Total", "total", "total", "decimal")}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {field("Card last 4", "cardLast4", "card_last4")}
            {field("Payment method", "paymentMethod", "payment_method")}
          </div>
        </div>
      </div>

      <Card shadow="sm">
        <CardBody className="p-4">
          <LineItems receiptId={receiptId} items={items} canEdit={canEdit} />
        </CardBody>
      </Card>

      <NotesField
        value={receipt.userNotes}
        canEdit={canEdit}
        onSave={(next) => update.mutate({ id: receiptId, userNotes: next })}
      />

      {update.isError ? (
        <p className="rounded bg-danger-50 p-3 text-sm text-danger">{update.error.message}</p>
      ) : null}

      <div className="flex flex-wrap items-start gap-2 border-t border-divider pt-4">
        {/* Outside the canEdit block on purpose. `receipts.emailReceipt`
            requires READ, not edit: a read-only member forwarding a receipt to
            a fellow member discloses nothing either of them could not already
            open. */}
        <EmailReceiptButton receiptId={receiptId} projectId={projectId} />
      </div>

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-divider pt-4">
          <Button
            size="sm"
            variant="flat"
            startContent={<RefreshCw className="h-4 w-4" />}
            isLoading={reextract.isPending}
            onPress={() => reextract.mutate({ id: receiptId })}
          >
            Re-extract
          </Button>
          {receipt.dismissedFields.length + receipt.acknowledgedFlags.length > 0 ? (
            <Chip size="sm" variant="flat" className="text-xs">
              Re-extracting clears{" "}
              {[
                receipt.dismissedFields.length > 0
                  ? `${receipt.dismissedFields.length} dismissed field${receipt.dismissedFields.length === 1 ? "" : "s"}`
                  : null,
                receipt.acknowledgedFlags.length > 0
                  ? `${receipt.acknowledgedFlags.length} acknowledged warning${receipt.acknowledgedFlags.length === 1 ? "" : "s"}`
                  : null,
              ]
                .filter(Boolean)
                .join(" and ")}
            </Chip>
          ) : null}
          <div className="flex-1" />
          <Button
            size="sm"
            color="danger"
            variant="light"
            startContent={<Trash2 className="h-4 w-4" />}
            onPress={() => setDeleteOpen(true)}
          >
            Delete
          </Button>
        </div>
      ) : null}

      {reextract.isError ? (
        <p className="rounded bg-danger-50 p-3 text-sm text-danger">{reextract.error.message}</p>
      ) : null}

      {/* disableAnimation — see ProjectList.tsx and providers.tsx. */}
      <Modal
        isOpen={isDeleteOpen}
        onClose={() => setDeleteOpen(false)}
        placement="center"
        disableAnimation
        className="z-[9999]"
      >
        <ModalContent>
          <ModalHeader>Delete this receipt?</ModalHeader>
          <ModalBody>
            <p className="text-sm">
              This removes the receipt and its image permanently. Deleting is the only way a receipt
              image is ever removed, and it cannot be undone.
            </p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setDeleteOpen(false)}>
              Keep it
            </Button>
            <Button
              color="danger"
              isLoading={remove.isPending}
              onPress={() => remove.mutate({ id: receiptId })}
            >
              Delete permanently
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}

/**
 * Notes, saved on blur. Controlled locally rather than read off the blur
 * event's target: HeroUI types that target as an input element, and casting it
 * to a textarea to reach `.value` is the kind of lie that compiles today and
 * breaks on a library upgrade.
 */
function NotesField({
  value,
  canEdit,
  onSave,
}: {
  value: string | null;
  canEdit: boolean;
  onSave: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [lastValue, setLastValue] = useState(value);

  // Adjusted during render, not in an effect — see EditableField for why.
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value ?? "");
  }

  return (
    <Textarea
      label="Notes"
      value={draft}
      isReadOnly={!canEdit}
      maxLength={10_000}
      onValueChange={setDraft}
      onBlur={() => {
        const next = draft.trim() || null;
        if (next === value) return;
        onSave(next);
      }}
    />
  );
}
