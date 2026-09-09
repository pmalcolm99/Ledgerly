"use client";

import { useState } from "react";
import {
  Button,
  Chip,
  Input,
  Select,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@heroui/react";
import { formatMoneyDisplay } from "@ledgerly/shared/moneyDisplay";
import { formatQuantityDisplay } from "@ledgerly/shared/numeric";
import { Plus, Sparkles, Trash2 } from "lucide-react";

import { trpc } from "../lib/trpc";

/**
 * The line-item table (brief §5): description, qty, unit price, total,
 * category. Add, edit, delete.
 *
 * `ai_assigned_category` is shown as a distinct chip (task 7.6's "visually
 * distinct"), because "the model guessed this" and "a person decided this"
 * are different claims about the same field, and only one of them is worth
 * re-checking before an export. Setting the category by hand clears the flag
 * server-side.
 *
 * Rows render in array order, not by `line_no`: deleting an item leaves a gap
 * in the numbering (the unique index tolerates gaps, and renumbering under a
 * non-deferrable unique index would collide mid-statement).
 */
export function LineItems({
  receiptId,
  items,
  canEdit,
}: {
  receiptId: string;
  items: Array<{
    id: string;
    lineNo: number;
    description: string;
    quantity: string | null;
    unitPrice: string | null;
    lineTotal: string | null;
    aiAssignedCategory: boolean;
    category: { id: string; name: string | null; color: string | null } | null;
  }>;
  canEdit: boolean;
}) {
  const utils = trpc.useUtils();
  const categories = trpc.categories.list.useQuery();
  const [isAdding, setAdding] = useState(false);

  const invalidate = () => utils.receipts.get.invalidate({ id: receiptId });

  const create = trpc.receiptItems.create.useMutation({
    onSuccess: async () => {
      setAdding(false);
      await invalidate();
    },
  });
  const update = trpc.receiptItems.update.useMutation({ onSuccess: invalidate });
  const remove = trpc.receiptItems.delete.useMutation({ onSuccess: invalidate });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Line items</h2>
        {canEdit ? (
          <Button
            size="sm"
            variant="flat"
            startContent={<Plus className="h-4 w-4" />}
            onPress={() => setAdding(true)}
          >
            Add item
          </Button>
        ) : null}
      </div>

      {/* Its own horizontal scroll container: a wide table must never make the
          page body scroll sideways on a phone. */}
      <div className="overflow-x-auto">
        <Table aria-label="Line items" removeWrapper className="min-w-[38rem]">
          <TableHeader>
            <TableColumn>Description</TableColumn>
            <TableColumn>Qty</TableColumn>
            <TableColumn>Unit</TableColumn>
            <TableColumn>Total</TableColumn>
            <TableColumn>Category</TableColumn>
            <TableColumn aria-label="Actions"> </TableColumn>
          </TableHeader>
          <TableBody emptyContent="No line items were read from this receipt.">
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="max-w-[16rem]">
                  <span className="block truncate">{item.description}</span>
                </TableCell>
                <TableCell className="tabular-nums">
                  {formatQuantityDisplay(item.quantity) || "—"}
                </TableCell>
                <TableCell className="tabular-nums">{formatMoneyDisplay(item.unitPrice)}</TableCell>
                <TableCell className="tabular-nums">{formatMoneyDisplay(item.lineTotal)}</TableCell>
                <TableCell>
                  {canEdit ? (
                    <div className="flex items-center gap-1">
                      <Select
                        aria-label={`Category for ${item.description}`}
                        size="sm"
                        className="min-w-[9rem]"
                        selectedKeys={item.category ? new Set([item.category.id]) : new Set()}
                        onSelectionChange={(keys) => {
                          const [next] = Array.from(keys as Set<string>);
                          if (!next || next === item.category?.id) return;
                          update.mutate({ id: item.id, categoryId: next });
                        }}
                      >
                        {(categories.data ?? []).map((category) => (
                          <SelectItem key={category.id}>{category.name}</SelectItem>
                        ))}
                      </Select>
                      {item.aiAssignedCategory ? (
                        <Chip
                          size="sm"
                          variant="flat"
                          color="secondary"
                          startContent={<Sparkles className="h-3 w-3" />}
                          title="Chosen by the extraction model — worth a glance"
                        >
                          AI
                        </Chip>
                      ) : null}
                    </div>
                  ) : (
                    <span className="flex items-center gap-1">
                      {item.category?.name ?? "Unassigned"}
                      {item.aiAssignedCategory ? (
                        <Sparkles className="h-3 w-3 text-secondary" aria-label="AI-assigned" />
                      ) : null}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {canEdit ? (
                    <Button
                      isIconOnly
                      size="sm"
                      variant="light"
                      color="danger"
                      aria-label={`Delete ${item.description}`}
                      isDisabled={remove.isPending}
                      onPress={() => remove.mutate({ id: item.id })}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {isAdding ? (
        <NewItemRow
          isSaving={create.isPending}
          error={create.error?.message ?? null}
          categories={categories.data ?? []}
          onCancel={() => setAdding(false)}
          onCreate={(values) => create.mutate({ receiptId, ...values })}
        />
      ) : null}

      {update.isError ? (
        <p className="rounded bg-danger-50 p-2 text-sm text-danger">{update.error.message}</p>
      ) : null}
      {remove.isError ? (
        <p className="rounded bg-danger-50 p-2 text-sm text-danger">{remove.error.message}</p>
      ) : null}
    </div>
  );
}

function NewItemRow({
  categories,
  onCreate,
  onCancel,
  isSaving,
  error,
}: {
  categories: Array<{ id: string; name: string }>;
  onCreate: (values: {
    description: string;
    quantity?: string;
    unitPrice?: string;
    lineTotal?: string;
    categoryId?: string;
  }) => void;
  onCancel: () => void;
  isSaving: boolean;
  error: string | null;
}) {
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [lineTotal, setLineTotal] = useState("");
  const [categoryId, setCategoryId] = useState("");

  return (
    // A plain div, not a <form>: this sits inside the receipt detail page,
    // which already has form controls, and nesting forms is the bug
    // FORKD_LESSONS.md documents browsers silently "fixing" by dropping the
    // inner tag and rewiring its button.
    <div className="flex flex-col gap-2 rounded-xl border border-divider p-3">
      <div className="flex flex-wrap gap-2">
        <Input
          size="sm"
          label="Description"
          className="min-w-[12rem] flex-1"
          value={description}
          onValueChange={setDescription}
          autoFocus
        />
        <Input
          size="sm"
          label="Qty"
          inputMode="decimal"
          className="max-w-[6rem]"
          value={quantity}
          onValueChange={setQuantity}
        />
        <Input
          size="sm"
          label="Unit price"
          inputMode="decimal"
          className="max-w-[8rem]"
          value={unitPrice}
          onValueChange={setUnitPrice}
        />
        <Input
          size="sm"
          label="Total"
          inputMode="decimal"
          className="max-w-[8rem]"
          value={lineTotal}
          onValueChange={setLineTotal}
        />
        <Select
          size="sm"
          label="Category"
          className="min-w-[10rem]"
          selectedKeys={categoryId ? new Set([categoryId]) : new Set()}
          onSelectionChange={(keys) => {
            const [first] = Array.from(keys as Set<string>);
            setCategoryId(first ?? "");
          }}
        >
          {categories.map((category) => (
            <SelectItem key={category.id}>{category.name}</SelectItem>
          ))}
        </Select>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          color="primary"
          isLoading={isSaving}
          isDisabled={!description.trim()}
          onPress={() =>
            onCreate({
              description: description.trim(),
              quantity: quantity.trim() || undefined,
              unitPrice: unitPrice.trim() || undefined,
              lineTotal: lineTotal.trim() || undefined,
              categoryId: categoryId || undefined,
            })
          }
        >
          Add
        </Button>
        <Button size="sm" variant="light" onPress={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
