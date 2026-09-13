"use client";

import { useCallback, useEffect, useState } from "react";
import { Input } from "@heroui/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";

/**
 * apps/web/src/components/ReceiptSearch.tsx — merchant search (D-47).
 *
 * In the URL rather than in component state, because a search is a filter and
 * `receiptFilters.ts` owns that mapping: the export button forwards `q` along
 * with everything else, so what downloads matches what is on screen.
 *
 * DEBOUNCED, which the other filters are not and do not need to be — they are
 * discrete controls that change once per interaction, while this one changes on
 * every keystroke. Without the delay, typing "hardware" is nine `router.replace`
 * calls and nine round trips, and the intermediate ones are answers to
 * questions nobody asked.
 */
const DEBOUNCE_MS = 300;

export function ReceiptSearch() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlValue = searchParams.get("q") ?? "";

  const [draft, setDraft] = useState(urlValue);

  const commit = useCallback(
    (value: string) => {
      // Read live at call time, never the render-time snapshot — the rule
      // `Filters.tsx` is built around, and for the same reason: this runs from
      // a timer, so its closure is older than the one in `Filters`.
      const next = new URLSearchParams(window.location.search);
      if (value.trim() === "") next.delete("q");
      else next.set("q", value.trim());
      const query = next.toString();
      router.replace(query ? `?${query}` : window.location.pathname, { scroll: false });
    },
    [router],
  );

  useEffect(() => {
    if (draft === urlValue) return;
    const timer = setTimeout(() => commit(draft), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, urlValue, commit]);

  return (
    <Input
      size="sm"
      className="w-full sm:max-w-64"
      aria-label="Search receipts by merchant"
      placeholder="Search merchants"
      value={draft}
      isClearable
      onValueChange={setDraft}
      onClear={() => {
        setDraft("");
        commit("");
      }}
      startContent={<Search className="h-4 w-4 shrink-0 text-default-400" aria-hidden />}
    />
  );
}
