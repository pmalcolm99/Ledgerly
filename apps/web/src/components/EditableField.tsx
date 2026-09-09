"use client";

import { Button, Input } from "@heroui/react";
import { AlertTriangle } from "lucide-react";

import { useEditableDraft } from "../lib/useEditableDraft";

/**
 * One inline-editable receipt field, with the "fill in or dismiss" affordance
 * the brief asks for (§5).
 *
 * A field in `missing_fields` is highlighted and offers two ways out, because
 * there genuinely are two: the value exists and the model missed it (type it
 * in), or the receipt truly does not have one (dismiss it). Offering only
 * "type it in" leaves a badge that can never be cleared on a receipt with no
 * phone number printed on it.
 *
 * Saves on blur rather than on every keystroke — a mutation per character
 * over a tunnel is unusable — and only when the value actually changed.
 */
export function EditableField({
  label,
  value,
  isMissing,
  isDismissed,
  canEdit,
  type = "text",
  placeholder,
  onSave,
  onDismiss,
  onUndismiss,
  isSaving,
}: {
  label: string;
  value: string | null;
  isMissing: boolean;
  isDismissed: boolean;
  canEdit: boolean;
  type?: "text" | "date" | "time" | "decimal";
  placeholder?: string;
  onSave: (next: string | null) => void;
  onDismiss?: () => void;
  onUndismiss?: () => void;
  isSaving?: boolean;
}) {
  // The draft/focus/commit contract lives in one place — see
  // lib/useEditableDraft.ts for why the re-sync must be suppressed while the
  // field is focused, which became load-bearing once these screens started
  // polling during extraction.
  const { draft, setDraft, onFocus, onBlur } = useEditableDraft(value, onSave);

  return (
    <div className="flex flex-col gap-1">
      <Input
        label={label}
        size="sm"
        // `decimal` rather than `numeric`: money has a decimal point, and
        // inputMode numeric hides it on iOS.
        inputMode={type === "decimal" ? "decimal" : undefined}
        type={type === "decimal" ? "text" : type}
        value={draft}
        placeholder={placeholder}
        isReadOnly={!canEdit}
        isDisabled={isSaving}
        onValueChange={setDraft}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
        classNames={{
          inputWrapper: isMissing ? "border-warning border-2" : undefined,
        }}
      />
      {isMissing && canEdit ? (
        <div className="flex items-center gap-2 text-xs text-warning">
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
          <span className="flex-1">Not read from the receipt</span>
          {onDismiss ? (
            <Button size="sm" variant="light" className="h-6 min-w-0 px-2" onPress={onDismiss}>
              Not on receipt
            </Button>
          ) : null}
        </div>
      ) : isDismissed && canEdit ? (
        <div className="flex items-center gap-2 text-xs text-default-400">
          <span className="flex-1">Marked as not on the receipt</span>
          {onUndismiss ? (
            <Button size="sm" variant="light" className="h-6 min-w-0 px-2" onPress={onUndismiss}>
              Undo
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
