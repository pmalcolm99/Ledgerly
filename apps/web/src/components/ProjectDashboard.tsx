"use client";

import { useSearchParams } from "next/navigation";
import { Button, Card, CardBody, Skeleton, Tooltip } from "@heroui/react";
import { formatMoneyDisplay } from "@ledgerly/shared/moneyDisplay";
import { Download } from "lucide-react";

import { trpc } from "../lib/trpc";
import { Capture } from "./Capture";
import { Filters } from "./Filters";
import { MemberManager } from "./MemberManager";
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

  const filters = {
    from: searchParams.get("from") || undefined,
    to: searchParams.get("to") || undefined,
    categoryId: searchParams.get("category") || undefined,
    uploadedBy: searchParams.get("uploadedBy") || undefined,
    needsReview: searchParams.get("needsReview") === "1" || undefined,
  };

  const stats = trpc.projects.stats.useQuery({
    projectId,
    from: filters.from,
    to: filters.to,
  });
  const receipts = trpc.receipts.list.useQuery({ projectId, ...filters, limit: 50 });

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
              {/* Phase 8 owns export. Rendered and disabled rather than
                  hidden, so the capability is discoverable and its absence is
                  explained rather than mysterious. */}
              <Tooltip content="Export arrives in the next phase">
                <span>
                  <Button
                    size="sm"
                    variant="flat"
                    isDisabled
                    startContent={<Download className="h-4 w-4" />}
                  >
                    Export
                  </Button>
                </span>
              </Tooltip>
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
                {Object.values(filters).some(Boolean)
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

      <MemberManager projectId={projectId} />
    </div>
  );
}
