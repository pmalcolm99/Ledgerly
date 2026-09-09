"use client";

import { useSearchParams } from "next/navigation";
import { Card, CardBody, Skeleton } from "@heroui/react";
import { formatMoneyDisplay } from "@ledgerly/shared/moneyDisplay";

import { trpc } from "../lib/trpc";
import { extractionRefetchInterval } from "../lib/extractionPolling";
import { hasAnyFilter, parseReceiptFilters } from "../lib/receiptFilters";
import { Capture } from "./Capture";
import { ExportButton } from "./ExportButton";
import { Filters } from "./Filters";
import { MemberManager } from "./MemberManager";
import { ProjectEmailSettings } from "./ProjectEmailSettings";
import { ReceiptRow } from "./ReceiptRow";
import { SpendByCategory } from "./SpendByCategory";
import { formatDateRange } from "../lib/dates";

/**
 * apps/web/src/components/ProjectDashboard.tsx — brief §3.
 *
 * Order on the page is deliberate and mobile-first: capture sits directly
 * under the header, above the chart and the list, because the common case is
 * opening this screen in order to photograph something. Analysis is what you
 * do later, at a desk.
 */
export function ProjectDashboard({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams();

  // Render-time read only. The export button rebuilds its own URL from
  // `window.location.search` at click time — see ExportButton.tsx.
  const filters = parseReceiptFilters(searchParams);

  // Polls while any receipt on screen is still extracting, and stops as soon
  // as none is. This query is the one the list below renders, so unlike the
  // poll that used to live in Capture it can never refresh a different cache
  // entry than the one being displayed.
  const receipts = trpc.receipts.list.useQuery(
    { projectId, ...filters, limit: 50 },
    {
      refetchInterval: (q) =>
        extractionRefetchInterval((q.state.data?.items ?? []).map((r) => r.extractionStatus)),
    },
  );

  const pendingInterval = extractionRefetchInterval(
    (receipts.data?.items ?? []).map((r) => r.extractionStatus),
  );

  const stats = trpc.projects.stats.useQuery(
    { projectId, from: filters.from, to: filters.to },
    {
      // The header totals are derived from the same rows, so they have to
      // follow the same clock — otherwise the list fills in and the spend
      // figure above it stays stale until a navigation.
      refetchInterval: pendingInterval,
    },
  );

  if (stats.isError) {
    return (
      <Card>
        <CardBody className="gap-2 p-5">
          <p className="font-semibold">Couldn&apos;t load this project.</p>
          <p className="text-sm text-default-500">{stats.error.message}</p>
        </CardBody>
      </Card>
    );
  }

  const project = stats.data?.project;
  const mixedCurrency = (project?.currencies.length ?? 0) > 1;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        {stats.isPending || !project ? (
          <Skeleton className="h-20 rounded-xl" />
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-2xl font-bold">{project.name}</h1>
                <p className="text-sm text-default-500">
                  {formatDateRange(project.startDate, project.endDate)}
                </p>
              </div>
              {/* Exports whatever filter is currently applied, so what
                  leaves matches what is on screen. */}
              <ExportButton projectId={projectId} />
            </div>

            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <span className="text-3xl font-bold tabular-nums">
                {mixedCurrency ? "Mixed currencies" : formatMoneyDisplay(project.totalSpend)}
              </span>
              <span className="text-sm text-default-500">
                {project.receiptCount} {project.receiptCount === 1 ? "receipt" : "receipts"}
              </span>
              {project.needsReviewCount > 0 ? (
                <span className="text-sm text-warning">{project.needsReviewCount} need review</span>
              ) : null}
            </div>
            {project.receiptsMissingTotal > 0 ? (
              <p className="text-xs text-default-500">
                {project.receiptsMissingTotal} receipt
                {project.receiptsMissingTotal === 1 ? " has" : "s have"} no total yet, so this
                figure is incomplete.
              </p>
            ) : null}
          </>
        )}
      </header>

      <Capture projectId={projectId} />

      <Card shadow="sm">
        <CardBody className="gap-3 p-4">
          <h2 className="text-lg font-semibold">Spend by category</h2>
          {stats.isPending || !stats.data ? (
            <Skeleton className="h-24 rounded-lg" />
          ) : (
            <SpendByCategory
              byCategory={stats.data.byCategory}
              totalSpend={stats.data.project.totalSpend}
            />
          )}
        </CardBody>
      </Card>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Receipts</h2>
        <Filters projectId={projectId} />

        {receipts.isPending ? (
          <div className="flex flex-col gap-2" aria-busy>
            {[0, 1, 2, 3].map((n) => (
              <Skeleton key={n} className="h-[4.5rem] rounded-xl" />
            ))}
          </div>
        ) : receipts.isError ? (
          <p className="rounded bg-danger-50 p-3 text-sm text-danger">{receipts.error.message}</p>
        ) : receipts.data.items.length === 0 ? (
          <Card shadow="none" className="border border-divider">
            <CardBody className="items-center gap-1 p-8 text-center">
              <p className="font-medium">No receipts match</p>
              <p className="text-sm text-default-500">
                {hasAnyFilter(filters)
                  ? "Try clearing the filters."
                  : "Add your first receipt with the button above."}
              </p>
            </CardBody>
          </Card>
        ) : (
          <ul className="flex flex-col gap-2">
            {receipts.data.items.map((receipt) => (
              <li key={receipt.id}>
                <ReceiptRow receipt={receipt} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <ProjectEmailSettings projectId={projectId} />

      <MemberManager projectId={projectId} />
    </div>
  );
}
