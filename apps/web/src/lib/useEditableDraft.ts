"use client";

import { useState } from "react";

/**
 * apps/web/src/lib/useEditableDraft.ts — the save-on-blur editing contract,
 * in one place.
 *
 * Two components need it (a receipt field and a line-item cell) and it has a
 * subtlety that is easy to get wrong in exactly one direction, so it lives
 * here rather than being written twice.
 *
 * ## The subtlety
 *
 * A field must re-sync when the server value changes underneath — an
 * extraction landing, or another member editing the same receipt. It must
 * NOT re-sync while the user is typing in it. Those screens are now rendered
 * under a poll that runs for as long as extraction does
 * (`lib/extractionPolling.ts`), so a refetch arriving mid-sentence would
 * replace the user's text with the server's — discarding an edit at the exact
 * moment they are correcting a field the model got wrong.
 *
 * The guard is `!isFocused`, and `lastValue` is deliberately left stale while
 * focused so the comparison fires once on blur instead of being lost.
 *
 * ## Why during render, not in an effect
 *
 * React re-runs the component immediately, before touching the DOM, so there
 * is no flash of the stale value and no second commit — whereas
 * `useEffect(() => setDraft(...), [value])` paints the old text first and
 * then repaints. This is React's documented pattern for adjusting state when
 * a prop changes, and it is what `react-hooks/set-state-in-effect` asks for.
 */
export function useEditableDraft(
  value: string | null,
  onSave: (next: string | null) => void,
): {
  draft: string;
  setDraft: (next: string) => void;
  onFocus: () => void;
  onBlur: () => void;
} {
  const [draft, setDraft] = useState(value ?? "");
  const [lastValue, setLastValue] = useState(value);
  const [isFocused, setIsFocused] = useState(false);

  if (value !== lastValue && !isFocused) {
    setLastValue(value);
    setDraft(value ?? "");
  }

  return {
    draft,
    setDraft,
    onFocus: () => setIsFocused(true),
    onBlur: () => {
      setIsFocused(false);
      const next = draft.trim() === "" ? null : draft.trim();
      if (next === value) return;
      // Adopt what we are sending as the value this field is synced to.
      // Without it, clearing `isFocused` un-suppresses the re-sync above and
      // a poll result that landed mid-edit overwrites the draft on the very
      // next render — before the save it just triggered comes back. The
      // server's own normalisation still lands afterwards, because the
      // mutation invalidates and `value` changes again.
      setLastValue(next);
      onSave(next);
    },
  };
}
