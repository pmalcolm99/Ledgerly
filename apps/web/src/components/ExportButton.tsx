"use client";

import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from "@heroui/react";
import { Download } from "lucide-react";

import { exportUrl } from "../lib/receiptFilters";

/**
 * apps/web/src/components/ExportButton.tsx — Phase 8's entry point.
 *
 * THE RULE THIS FILE INHERITS (task 7.7, `Filters.tsx`): the download URL is
 * built from `window.location.search` INSIDE the handler, never from a
 * `useSearchParams()` value captured at render. A closure here would be the
 * same bug in a worse place — the filter panel would show one thing and the
 * spreadsheet would contain another, and nothing on screen would say so.
 *
 * A plain navigation rather than an `<a download>`: the response carries
 * `Content-Disposition: attachment`, so the browser saves it and never
 * leaves the page. That also keeps the Cloudflare Access cookie on the
 * request, which a `fetch` + blob dance would not obviously do.
 */
export function ExportButton({ projectId }: { projectId: string }) {
  const download = (format: "xlsx" | "csv"): void => {
    window.location.assign(exportUrl(projectId, window.location.search, format));
  };

  return (
    <Dropdown>
      <DropdownTrigger>
        <Button size="sm" variant="flat" startContent={<Download className="h-4 w-4" />}>
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
  );
}
