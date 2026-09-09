"use client";

import { useState } from "react";
import { Button, Chip, Input, Select, SelectItem } from "@heroui/react";
import { formatMoneyDisplay } from "@ledgerly/shared/moneyDisplay";
import { formatQuantityDisplay } from "@ledgerly/shared/numeric";
import { Plus, Sparkles, Trash2 } from "lucide-react";

import { trpc } from "../lib/trpc";
import { useEditableDraft } from "../lib/useEditableDraft";

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
 *
 * ## Why this is a grid and not a <Table>
 *
 * It was a HeroUI `<Table>` with `min-w-[38rem]` — a hard 608px floor inside
 * an `overflow-x-auto`. That guaranteed a horizontal scrollbar on every phone
 * this app is actually used from, which is the reported bug. A table cannot
 * reflow: its cells are locked into one row.
 *
 * A CSS grid can. Below `sm` each item is a stacked card — description on its
 * own line, then quantity/unit/total, then category — and at `sm` and up the
 * same markup snaps into aligned columns with a header. One DOM per item, no
 * duplicated branches, and nothing scrolls sideways.
 *
 * ## Every field is editable
 *
 * Description, quantity, unit price and line total were read-only after
 * creation, so a mis-read line could only be fixed by deleting and re-adding
 * it. `receiptItems.update` already accepted all four — this was purely a
 * missing UI. Editing commits on blur, and `recomputeReceiptDerivedState`
 * server-side means a corrected line total can clear an arithmetic warning on
 * the receipt, which is why every mutation invalidates `receipts.get`.
 */
/**
 * One template, used by the header and every row, so the columns line up
 * without a table. Below `sm` it is two columns and everything wraps; at `sm`
 * it becomes the five-column layout with a trailing action cell.
 * `minmax(0,...)` on the flexible tracks is what actually lets long text
 * truncate rather than forcing the grid wider than its container.
 */
const GRID =
  "grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,4fr)_4.5rem_6rem_6rem_minmax(0,3fr)_2.5rem] sm:gap-3";

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

  // Only the row being saved disables, not every row.
  const savingId = update.isPending ? update.variables?.id : undefined;

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

      {items.length === 0 ? (
        <p className="py-2 text-sm text-default-500">No line items were read from this receipt.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {/* The column header exists only where there are columns. */}
          <div className={`${GRID} hidden text-xs text-default-500 sm:grid`}>
            <span>Description</span>
            <span className="text-right">Qty</span>
            <span className="text-right">Unit</span>
            <span className="text-right">Total</span>
            <span>Category</span>
            <span aria-hidden />
          </div>

          {items.map((item) => (
            <div
              key={item.id}
              className={`${GRID} items-center rounded-lg border border-divider p-2 sm:rounded-none sm:border-0 sm:border-b sm:p-0 sm:pb-2`}
            >
              <ItemField
                label="Description"
                value={item.description}
                canEdit={canEdit}
                className="col-span-2 sm:col-span-1"
                isSaving={savingId === item.id}
                onSave={(next) => {
                  // NOT NULL in the schema, so an emptied description is a
                  // no-op rather than a write that would fail server-side.
                  if (next !== null) update.mutate({ id: item.id, description: next });
                }}
              />
              <ItemField
                label="Qty"
                value={item.quantity}
                canEdit={canEdit}
                numeric
                display={formatQuantityDisplay(item.quantity)}
                isSaving={savingId === item.id}
                onSave={(next) => update.mutate({ id: item.id, quantity: next })}
              />
              <ItemField
                label="Unit"
                value={item.unitPrice}
                canEdit={canEdit}
                numeric
                display={formatMoneyDisplay(item.unitPrice)}
                isSaving={savingId === item.id}
                onSave={(next) => update.mutate({ id: item.id, unitPrice: next })}
              />
              <ItemField
                label="Total"
                value={item.lineTotal}
                canEdit={canEdit}
                numeric
                display={formatMoneyDisplay(item.lineTotal)}
                isSaving={savingId === item.id}
                onSave={(next) => update.mutate({ id: item.id, lineTotal: next })}
              />

              <div className="col-span-2 flex min-w-0 items-center gap-1 sm:col-span-1">
                {canEdit ? (
                  <Select
                    aria-label={`Category for ${item.description}`}
                    size="sm"
                    className="min-w-0 flex-1"
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
                ) : (
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {item.category?.name ?? "Unassigned"}
                  </span>
                )}
                {item.aiAssignedCategory ? (
                  <Chip
                    size="sm"
                    variant="flat"
                    color="secondary"
                    className="shrink-0"
                    startContent={<Sparkles className="h-3 w-3" />}
                    title="Chosen by the extraction model — worth a glance"
                  >
                    AI
                  </Chip>
                ) : null}
              </div>

              <div className="flex justify-end">
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
              </div>
            </div>
          ))}
        </div>
      )}

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

/**
 * One editable line-item cell.
 *
 * A compact sibling of `EditableField` — same commit-on-blur contract, via
 * the same `useEditableDraft` hook, but without the labelled input and
 * missing-field affordances that belong on the receipt form. The `label` is
 * rendered only below `sm`, where the grid has no column headers to explain
 * what the value is.
 */
function ItemField({
  label,
  value,
  display,
  canEdit,
  numeric,
  className,
  isSaving,
  onSave,
}: {
  label: string;
  value: string | null;
  /** Formatted for reading. The raw `value` is what gets edited. */
  display?: string;
  canEdit: boolean;
  numeric?: boolean;
  className?: string;
  isSaving?: boolean;
  onSave: (next: string | null) => void;
}) {
  const { draft, setDraft, onFocus, onBlur } = useEditableDraft(value, onSave);

  // Below `sm` the grid drops its column headers, so each cell has to say what
  // it is. Above `sm` the header row does that and this would be noise.
  const caption = <span className="text-xs text-default-500 sm:hidden">{label}</span>;

  if (!canEdit) {
    return (
      <div className={`flex min-w-0 flex-col ${className ?? ""}`}>
        {caption}
        <span className={`truncate text-sm ${numeric ? "tabular-nums sm:text-right" : ""}`}>
          {display || value || "—"}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex min-w-0 flex-col gap-0.5 ${className ?? ""}`}>
      {caption}
      <Input
        aria-label={label}
        size="sm"
        variant="bordered"
        classNames={{
          // `min-w-0` on the wrapper too: HeroUI's inner flex container has the
          // same `min-width: auto` floor that would otherwise stop the grid
          // track from shrinking on a narrow screen.
          base: "min-w-0",
          inputWrapper: "h-8 min-h-8",
          input: numeric ? "tabular-nums sm:text-right" : "",
        }}
        // `decimal` rather than `numeric`: money has a decimal point, and
        // `numeric` hides it on the iOS keypad.
        inputMode={numeric ? "decimal" : undefined}
        value={draft}
        isDisabled={isSaving}
        onValueChange={setDraft}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={(event) => {
          // Enter commits by blurring, so there is exactly one commit path.
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}
