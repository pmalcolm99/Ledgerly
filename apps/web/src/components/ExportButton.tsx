"use client";

import { useState } from "react";
import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from "@heroui/react";
import { Download } from "lucide-react";

import { exportUrl } from "../lib/receiptFilters";
import { browserSaveDeps, saveExport } from "../lib/exportDownload";

/**
 * apps/web/src/components/ExportButton.tsx — Phase 8's entry point.
 *
 * THE RULE THIS FILE INHERITS (task 7.7, `Filters.tsx`): the download URL is
 * built from `window.location.search` INSIDE the handler, never from a
 * `useSearchParams()` value captured at render. A closure here would be the
 * same bug in a worse place — the filter panel would show one thing and the
 * spreadsheet would contain another, and nothing on screen would say so.
 *
 * How the file actually reaches the device lives in `lib/exportDownload.ts`,
 * which explains why an installed iOS app needs a different route from a
 * browser tab. What belongs here is the two things a component owes the user
 * while that happens: **something has to move, and a failure has to be
 * visible.** The bug this fixes was silent — a blank view and no file — and a
 * silent failure is the one kind this app keeps promising not to ship.
 */
export function ExportButton({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = (format: "xlsx" | "csv"): void => {
    setError(null);
    setBusy(true);
    // The URL is read here, synchronously, inside the gesture — see the rule
    // above.
    const url = exportUrl(projectId, window.location.search, format);
    void saveExport(url, `export.${format}`, browserSaveDeps())
      .then((result) => {
        if (!result.ok) setError(result.message);
      })
      .catch(() => {
        setError("The export could not be saved.");
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Dropdown>
        <DropdownTrigger>
          <Button
            size="sm"
            variant="flat"
            isLoading={busy}
            startContent={busy ? undefined : <Download className="h-4 w-4" />}
          >
            Export
          </Button>
        </DropdownTrigger>
        <DropdownMenu
          aria-label="Export format"
          onAction={(key) => download(key === "csv" ? "csv" : "xlsx")}
        >
          <DropdownItem key="xlsx" description="Three sheets: line items, receipts, summary">
            Excel (.xlsx)
          </DropdownItem>
          <DropdownItem key="csv" description="Line items only">
            CSV (.csv)
          </DropdownItem>
        </DropdownMenu>
      </Dropdown>
      {error ? <p className="max-w-64 text-right text-xs text-danger">{error}</p> : null}
    </div>
  );
}
