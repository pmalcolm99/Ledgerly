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
 * ## Why a new window and not `window.location.assign`
 *
 * It was `assign`, and on a desktop browser that is fine: `Content-Disposition:
 * attachment` means the file is saved and the page never actually navigates.
 *
 * Installed on an iOS home screen it is not fine. A standalone PWA has exactly
 * one document and no browser chrome, so navigating it hands the whole screen
 * to the "Open in 'Excel'" sheet — with no back button, no address bar, and no
 * history entry to return to. The only way out was to kill the app. That is
 * the reported bug.
 *
 * A `target="_blank"` anchor hands the download to Safari instead and leaves
 * the installed app's document untouched, so dismissing the share sheet
 * returns you to where you were. Same origin, so the Cloudflare Access cookie
 * still rides along, and the response headers and streaming body are
 * unchanged — a `fetch` + blob dance would be the thing that risked the
 * cookie, and would also buffer a stream that exists precisely so it is not
 * buffered.
 *
 * An anchor rather than `window.open`: passing `noopener` in the features
 * string makes `open` return null BY SPEC, so there is no way to tell a
 * blocked popup from a successful one and any "did it work?" fallback fires
 * every time — opening the file twice. A synthetic anchor click inside a user
 * gesture has neither problem, and `rel="noopener"` on it still denies the new
 * context a `window.opener` handle back into this app.
 */
export function ExportButton({ projectId }: { projectId: string }) {
  const download = (format: "xlsx" | "csv"): void => {
    const link = document.createElement("a");
    link.href = exportUrl(projectId, window.location.search, format);
    link.target = "_blank";
    link.rel = "noopener";
    // Not `download`: the filename comes from the server's
    // Content-Disposition (it encodes the project slug and the export date),
    // and a `download` attribute would override it with the URL's last
    // segment. It also has no effect cross-document on iOS.
    document.body.append(link);
    link.click();
    link.remove();
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
