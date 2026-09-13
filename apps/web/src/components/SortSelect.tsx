"use client";

import { Select, SelectItem } from "@heroui/react";
import {
  DEFAULT_RECEIPT_SORT,
  RECEIPT_SORTS,
  RECEIPT_SORT_LABELS,
  isReceiptSort,
} from "@ledgerly/shared/receiptSort";

import { trpc } from "../lib/trpc";

/**
 * apps/web/src/components/SortSelect.tsx — receipt ordering (D-47).
 *
 * A PREFERENCE, not a filter, so it lives on the user row rather than in the
 * URL: the user asked for a choice that persists until they change it, and a
 * URL parameter would reset on every fresh navigation to the project. The
 * filters beside it stay in the URL for the opposite reason — a filtered view
 * is something you share or export.
 *
 * Written optimistically through the query cache, the same shape `applyTheme`
 * uses for the other per-user preference: the list re-sorts on the click rather
 * than after a round trip, and a failed write rolls the cache back so the
 * control cannot end up disagreeing with what the server will serve next time.
 */
export function SortSelect() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const sort = me.data?.receiptSort ?? DEFAULT_RECEIPT_SORT;

  const setSort = trpc.auth.setReceiptSort.useMutation({
    onMutate: async ({ sort: next }) => {
      await utils.auth.me.cancel();
      const previous = utils.auth.me.getData();
      if (previous) utils.auth.me.setData(undefined, { ...previous, receiptSort: next });
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) utils.auth.me.setData(undefined, context.previous);
    },
    onSettled: async () => {
      await utils.auth.me.invalidate();
    },
  });

  return (
    <Select
      size="sm"
      aria-label="Sort receipts"
      className="w-full sm:max-w-52"
      selectedKeys={new Set([sort])}
      onSelectionChange={(keys) => {
        const [first] = Array.from(keys as Set<string>);
        if (first && isReceiptSort(first) && first !== sort) setSort.mutate({ sort: first });
      }}
    >
      {RECEIPT_SORTS.map((option) => (
        <SelectItem key={option}>{RECEIPT_SORT_LABELS[option]}</SelectItem>
      ))}
    </Select>
  );
}
