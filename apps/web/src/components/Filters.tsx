"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectItem,
} from "@heroui/react";
import { FilterX, SlidersHorizontal } from "lucide-react";

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
 * to compute the next URL. Collapsing the controls into a popover does not
 * change that — `updateFilter` still reads live at call time.
 *
 * ## Why a popover
 *
 * Laid out inline, the six controls are `flex-col` until the `sm` breakpoint,
 * so on a phone they stack into roughly 300px of chrome sitting permanently
 * between the "Receipts" heading and the receipts themselves — on the screen
 * whose entire purpose is the list underneath. The trigger carries a count
 * badge so an active filter is still visible at a glance while collapsed,
 * which is the one thing a disclosure must not hide: a list that is silently
 * filtered looks like a list that is empty.
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

  const activeCount = [from, to, categoryId, uploadedBy, needsReview ? "1" : ""].filter(
    Boolean,
  ).length;

  return (
    <div className="flex items-center gap-2">
      <Popover placement="bottom-start" offset={8}>
        <PopoverTrigger>
          <Button
            size="sm"
            variant={hasAny ? "solid" : "flat"}
            color={hasAny ? "primary" : "default"}
            startContent={<SlidersHorizontal className="h-4 w-4" aria-hidden />}
          >
            Filters
            {/* A plain count chip, not HeroUI's <Badge>: Badge WRAPS the
                element it decorates and positions itself absolutely against
                it, which is wrong for a count sitting inline in a label. */}
            {activeCount > 0 ? (
              <span className="ml-1 rounded-full bg-primary-foreground/25 px-1.5 text-xs tabular-nums">
                {activeCount}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        {/* `w-[min(20rem,calc(100vw-2rem))]` rather than a fixed width: at a
            390px viewport a 20rem popover would otherwise sit flush against
            both edges. */}
        <PopoverContent className="w-[min(20rem,calc(100vw-2rem))] p-3">
          <div className="flex w-full flex-col gap-3">
            <div className="flex gap-2">
              <Input
                type="date"
                size="sm"
                label="From"
                value={from}
                onValueChange={(value) => updateFilter("from", value || null)}
              />
              <Input
                type="date"
                size="sm"
                label="To"
                value={to}
                onValueChange={(value) => updateFilter("to", value || null)}
              />
            </div>
            <Select
              size="sm"
              label="Category"
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
                Clear all
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>

      {/* Outside the popover on purpose. A filtered list that looks empty is
          the failure mode a disclosure introduces, so the fact that filters
          are on stays on screen even when the panel is shut. */}
      {hasAny ? (
        <Button
          size="sm"
          variant="light"
          className="text-default-500"
          startContent={<FilterX className="h-4 w-4" aria-hidden />}
          onPress={() => router.replace(window.location.pathname, { scroll: false })}
        >
          Clear
        </Button>
      ) : null}
    </div>
  );
}
