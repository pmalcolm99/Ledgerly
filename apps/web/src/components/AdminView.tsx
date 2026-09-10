"use client";

import NextLink from "next/link";
import { Card, CardBody, Chip, Skeleton } from "@heroui/react";
import { formatMoneyDisplay } from "@ledgerly/shared/moneyDisplay";

import { trpc } from "../lib/trpc";
import { AiKeyCard } from "./AiKeyCard";
import { BackupsCard } from "./BackupsCard";
import { SmtpCard } from "./SmtpCard";

/**
 * apps/web/src/components/AdminView.tsx — brief §7: all projects, all users,
 * extraction cost and escalation rate, backup status.
 *
 * The backup section is `BackupsCard.tsx`. It was inline here through Phase 8
 * as a disabled button; Phase 9 gave it a schedule form, a per-row download, a
 * summary and three different failure callouts, which is more than belongs in
 * the middle of this file.
 */
export function AdminView() {
  const overview = trpc.admin.overview.useQuery();
  const usage = trpc.admin.aiUsage.useQuery({ sinceDays: 30 });

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-bold">Admin</h1>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Users" value={overview.data?.totals.userCount} />
        <Stat label="Projects" value={overview.data?.totals.projectCount} />
        <Stat label="Receipts" value={overview.data?.totals.receiptCount} />
        <Stat label="Need review" value={overview.data?.totals.needsReviewCount} />
      </div>

      <AiKeyCard />
      <SmtpCard />

      <Card shadow="sm">
        <CardBody className="gap-3 p-4">
          <h2 className="text-lg font-semibold">Extraction cost — last 30 days</h2>
          {usage.isPending ? (
            <Skeleton className="h-20 rounded-lg" />
          ) : usage.isError ? (
            <p className="text-sm text-danger">{usage.error.message}</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-x-8 gap-y-2">
                <div>
                  <p className="text-xs text-default-500">Estimated spend</p>
                  <p className="text-xl font-semibold tabular-nums">
                    {usage.data.totalCostUsd === null
                      ? "Unknown model"
                      : `$${usage.data.totalCostUsd.toFixed(2)}`}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-default-500">Escalation rate</p>
                  <p className="text-xl font-semibold tabular-nums">
                    {usage.data.escalationRate === null
                      ? "—"
                      : `${Math.round(usage.data.escalationRate * 100)}%`}
                  </p>
                  {/* D-12's threshold: above roughly 45%, going Sonnet-first is
                      cheaper than the two-pass ladder. */}
                  {usage.data.escalationRate !== null && usage.data.escalationRate > 0.45 ? (
                    <p className="text-xs text-warning">
                      Above ~45% — Sonnet-first would now be cheaper (D-12).
                    </p>
                  ) : null}
                </div>
                <div>
                  <p className="text-xs text-default-500">Calls</p>
                  <p className="text-xl font-semibold tabular-nums">{usage.data.totalCalls}</p>
                </div>
              </div>

              {usage.data.models.length > 0 ? (
                <ul className="flex flex-col divide-y divide-divider text-sm">
                  {usage.data.models.map((model) => (
                    <li key={model.model} className="flex items-center gap-3 py-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {model.model}
                      </span>
                      <span className="text-default-500">{model.calls} calls</span>
                      <span className="tabular-nums">
                        {model.costUsd === null ? "—" : `$${model.costUsd.toFixed(2)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-default-500">No extraction calls in this window.</p>
              )}
            </>
          )}
        </CardBody>
      </Card>

      <BackupsCard />

      <Card shadow="sm">
        <CardBody className="gap-3 p-4">
          <h2 className="text-lg font-semibold">Projects</h2>
          {overview.isPending ? (
            <Skeleton className="h-32 rounded-lg" />
          ) : overview.isError ? (
            <p className="text-sm text-danger">{overview.error.message}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-divider">
              {overview.data.projects.map((project) => (
                <li key={project.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <NextLink
                    href={`/projects/${project.id}`}
                    className="min-w-0 flex-1 truncate font-medium hover:underline"
                  >
                    {project.name}
                  </NextLink>
                  {project.status === "archived" ? (
                    <Chip size="sm" variant="flat" className="shrink-0">
                      Archived
                    </Chip>
                  ) : null}
                  {/* The name link already truncates correctly. These trailing
                      cells did not: with nothing stopping them from claiming
                      their full content width, `flex-wrap` threw them onto a
                      second line and the row silently doubled in height
                      instead of the long value truncating. The owner name is
                      the one that can overflow on its own, so it gets
                      `min-w-0 truncate`; the rest are short and just need to
                      stop shrinking. */}
                  <span className="min-w-0 max-w-[10rem] truncate text-default-500">
                    {project.owner.name}
                  </span>
                  <span className="shrink-0 text-default-500">{project.memberCount} members</span>
                  <span className="shrink-0 text-default-500">{project.receiptCount} receipts</span>
                  {project.needsReviewCount > 0 ? (
                    <span className="shrink-0 text-warning">
                      {project.needsReviewCount} to review
                    </span>
                  ) : null}
                  <span className="shrink-0 tabular-nums">
                    {formatMoneyDisplay(project.totalSpend)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card shadow="sm">
        <CardBody className="gap-3 p-4">
          <h2 className="text-lg font-semibold">Users</h2>
          {overview.isPending ? (
            <Skeleton className="h-32 rounded-lg" />
          ) : overview.isError ? null : (
            <ul className="flex flex-col divide-y divide-divider">
              {overview.data.users.map((user) => (
                <li key={user.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">{user.name}</span>
                  {/* `min-w-0` is what makes `truncate` work here. A flex item
                      defaults to `min-width: auto`, which refuses to shrink
                      below its content — so `truncate` alone did nothing and a
                      long address pushed the whole row wide. `basis-full
                      sm:basis-auto` gives the email its own line on a phone
                      rather than fighting the name for the same one. */}
                  <span className="min-w-0 basis-full truncate text-default-500 sm:basis-auto sm:max-w-[16rem]">
                    {user.email}
                  </span>
                  {user.role === "owner" ? (
                    <Chip size="sm" variant="flat" color="primary" className="shrink-0">
                      Instance owner
                    </Chip>
                  ) : null}
                  {!user.onboardedAt ? (
                    <Chip size="sm" variant="flat" className="shrink-0">
                      Not onboarded
                    </Chip>
                  ) : null}
                  <span className="shrink-0 text-default-500">{user.projectsOwned} owned</span>
                  <span className="shrink-0 text-default-500">
                    {user.receiptsUploaded} uploaded
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <Card shadow="none" className="border border-divider">
      <CardBody className="gap-1 p-4">
        <p className="text-xs text-default-500">{label}</p>
        {value === undefined ? (
          <Skeleton className="h-7 w-12 rounded" />
        ) : (
          <p className="text-2xl font-bold tabular-nums">{value}</p>
        )}
      </CardBody>
    </Card>
  );
}
