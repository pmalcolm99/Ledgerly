import { Chip } from "@heroui/react";
import { AlertTriangle, Check, CircleSlash, Loader2 } from "lucide-react";

import type { ReceiptReviewState } from "../lib/receiptLabels";

/**
 * The one badge that says what state a receipt is in. Colour alone never
 * carries the meaning — each state has its own icon and its own word — so it
 * still reads correctly in bright sun in a parking lot, and for anyone who
 * can't distinguish the hues.
 */
export function ReviewBadge({
  state,
  count,
  size = "sm",
}: {
  state: ReceiptReviewState;
  count?: number;
  size?: "sm" | "md";
}) {
  if (state === "clear") {
    return (
      <Chip size={size} variant="flat" color="success" startContent={<Check className="h-3 w-3" />}>
        Complete
      </Chip>
    );
  }
  if (state === "processing") {
    return (
      <Chip
        size={size}
        variant="flat"
        color="default"
        startContent={<Loader2 className="h-3 w-3 animate-spin" />}
      >
        Reading…
      </Chip>
    );
  }
  if (state === "failed") {
    return (
      <Chip
        size={size}
        variant="flat"
        color="danger"
        startContent={<CircleSlash className="h-3 w-3" />}
      >
        Couldn&apos;t read
      </Chip>
    );
  }
  return (
    <Chip
      size={size}
      variant="flat"
      color="warning"
      startContent={<AlertTriangle className="h-3 w-3" />}
    >
      {count && count > 0 ? `${count} to check` : "Needs review"}
    </Chip>
  );
}
