"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { Button, Input, Select, SelectItem } from "@heroui/react";
import { FilterX } from "lucide-react";

import { trpc } from "../lib/trpc";

/**
 * apps/web/src/components/Filters.tsx — dashboard filters (task 7.7).
 *
 * THE BUG THIS FILE IS SHAPED AROUND (FORKD_LESSONS.md): a debounced handler
 * captured `searchParams` at mount, when it was empty. 300ms later another
 * effect set `?state=CO`; the debounced callback then rebuilt the URL from its
 * stale, empty copy and wiped the other filter. It was timing-dependent —
 * navigate fast and it worked, pause on the screen and a filter vanished.
 *
 * The fix, and the rule for this file: **read the current query string inside
 * the handler, from `window.location.search`, never from a closure.** The
 * `useSearchParams()` value below is used ONLY to render current values, never
 * to compute the next URL.
 */
export function Filters({ projectId }: { projectId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const categories = trpc.categories.list.useQuery();
  const members = trpc.members.list.useQuery({ projectId });

  const updateFilter = useCallback(
    (key: string, value: string | null) => {
      // Read live, at call time. Not `searchParams`, which is a snapshot from
      // the render that created this callback.
      const next = new URLSearchParams(window.location.search);
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
      const query = next.toString();
      router.replace(query ? `?${query}` : window.location.pathname, { scroll: false });
    },
    [router],
  );

  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const categoryId = searchParams.get("category") ?? "";
  const uploadedBy = searchParams.get("uploadedBy") ?? "";
  const needsReview = searchParams.get("needsReview") === "1";
  const hasAny = Boolean(from || to || categoryId || uploadedBy || needsReview);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
      <Input
        type="date"
        size="sm"
        label="From"
        className="sm:max-w-[10rem]"
        value={from}
        onValueChange={(value) => updateFilter("from", value || null)}
      />
      <Input
        type="date"
        size="sm"
        label="To"
        className="sm:max-w-[10rem]"
        value={to}
        onValueChange={(value) => updateFilter("to", value || null)}
      />
      <Select
        size="sm"
        label="Category"
        className="sm:max-w-[12rem]"
        selectedKeys={categoryId ? new Set([categoryId]) : new Set()}
        onSelectionChange={(keys) => {
          const [first] = Array.from(keys as Set<string>);
          updateFilter("category", first ?? null);
        }}
      >
        {(categories.data ?? []).map((category) => (
          <SelectItem key={category.id}>{category.name}</SelectItem>
        ))}
      </Select>
      <Select
        size="sm"
        label="Uploaded by"
        className="sm:max-w-[12rem]"
        selectedKeys={uploadedBy ? new Set([uploadedBy]) : new Set()}
        onSelectionChange={(keys) => {
          const [first] = Array.from(keys as Set<string>);
          updateFilter("uploadedBy", first ?? null);
        }}
      >
        {(members.data ?? []).map((member) => (
          <SelectItem key={member.userId}>{member.name}</SelectItem>
        ))}
      </Select>
      <Button
        size="sm"
        variant={needsReview ? "solid" : "flat"}
        color={needsReview ? "warning" : "default"}
        onPress={() => updateFilter("needsReview", needsReview ? null : "1")}
      >
        Needs review
      </Button>
      {hasAny ? (
        <Button
          size="sm"
          variant="light"
          startContent={<FilterX className="h-4 w-4" />}
          onPress={() => router.replace(window.location.pathname, { scroll: false })}
        >
          Clear
        </Button>
      ) : null}
    </div>
  );
}
