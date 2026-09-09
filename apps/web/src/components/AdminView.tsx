"use client";

import NextLink from "next/link";
import { Button, Card, CardBody, Chip, Skeleton, Tooltip } from "@heroui/react";
import { formatMoneyDisplay } from "@ledgerly/shared/moneyDisplay";
import { Database, HardDriveDownload } from "lucide-react";

import { trpc } from "../lib/trpc";

/**
 * apps/web/src/components/AdminView.tsx — brief §7: all projects, all users,
 * extraction cost and escalation rate, backup status.
 */
export function AdminView() {
  const overview = trpc.admin.overview.useQuery();
  const usage = trpc.admin.aiUsage.useQuery({ sinceDays: 30 });
  const backups = trpc.admin.backups.useQuery();

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-bold">Admin</h1>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Users" value={overview.data?.totals.userCount} />
        <Stat label="Projects" value={overview.data?.totals.projectCount} />
        <Stat label="Receipts" value={overview.data?.totals.receiptCount} />
        <Stat label="Need review" value={overview.data?.totals.needsReviewCount} />
      </div>

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

      <Card shadow="sm">
        <CardBody className="gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Database className="h-5 w-5" aria-hidden />
              Backups
            </h2>
            {/*
              Phase 9 owns the backup job, its schedule, retention, and the
              restore drill. Nothing in the codebase writes a `backups` row
              yet, so this button is rendered and disabled rather than hidden:
              an operator should be able to see that backups are a planned
              capability and that they are not running, instead of finding no
              mention of them and assuming they are.
            */}
            <Tooltip content="Backups arrive in phase 9">
              <span>
                <Button
                  size="sm"
                  variant="flat"
                  isDisabled
                  startContent={<HardDriveDownload className="h-4 w-4" />}
                >
                  Back up now
                </Button>
              </span>
            </Tooltip>
          </div>

          {backups.isPending ? (
            <Skeleton className="h-16 rounded-lg" />
          ) : backups.isError ? (
            <p className="text-sm text-danger">{backups.error.message}</p>
          ) : backups.data.length === 0 ? (
            <p className="rounded-lg border border-warning-200 bg-warning-50/50 p-3 text-sm">
              <strong>No backups have ever run.</strong> The backup job lands in phase 9. Until
              then, this instance&apos;s database and uploaded images are not being backed up by
              Ledgerly itself.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-divider text-sm">
              {backups.data.map((backup) => (
                <li key={backup.id} className="flex items-center gap-3 py-2">
                  <Chip
                    size="sm"
                    variant="flat"
                    color={
                      backup.status === "complete"
                        ? "success"
                        : backup.status === "failed"
                          ? "danger"
                          : "default"
                    }
                  >
                    {backup.status}
                  </Chip>
                  <span className="flex-1 text-default-500">{backup.kind}</span>
                  <span className="tabular-nums">
                    {backup.sizeBytes ? `${(backup.sizeBytes / 1_048_576).toFixed(1)} MB` : "—"}
                  </span>
                  <span className="text-xs text-default-400">
                    {backup.startedAt.toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

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
                    <Chip size="sm" variant="flat">
                      Archived
                    </Chip>
                  ) : null}
                  <span className="text-default-500">{project.owner.name}</span>
                  <span className="text-default-500">{project.memberCount} members</span>
                  <span className="text-default-500">{project.receiptCount} receipts</span>
                  {project.needsReviewCount > 0 ? (
                    <span className="text-warning">{project.needsReviewCount} to review</span>
                  ) : null}
                  <span className="tabular-nums">{formatMoneyDisplay(project.totalSpend)}</span>
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
                  <span className="truncate text-default-500">{user.email}</span>
                  {user.role === "owner" ? (
                    <Chip size="sm" variant="flat" color="primary">
                      Instance owner
                    </Chip>
                  ) : null}
                  {!user.onboardedAt ? (
                    <Chip size="sm" variant="flat">
                      Not onboarded
                    </Chip>
                  ) : null}
                  <span className="text-default-500">{user.projectsOwned} owned</span>
                  <span className="text-default-500">{user.receiptsUploaded} uploaded</span>
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
