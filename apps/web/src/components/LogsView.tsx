"use client";

import { useState } from "react";
import { Button, Card, CardBody, Chip, Skeleton } from "@heroui/react";
import { ScrollText } from "lucide-react";
import { EVENT_CATEGORIES } from "@ledgerly/shared/events";

import { trpc } from "../lib/trpc";
import { buildLabel } from "../lib/buildInfo";
import { levelColor, logLabel } from "../lib/logLabels";

/**
 * apps/web/src/components/LogsView.tsx — the Logs tab (D-46).
 *
 * One chronological timeline over `audit_log` (what a person did) and
 * `app_events` (what the system did). It exists because diagnosing the
 * automatic receipt email required reading container logs: an email that was
 * skipped, failed, or never queued left no trace anywhere in the product.
 *
 * The app's **first** paginated list — `ProjectDashboard` and `ReviewQueue` both
 * drop `nextCursor` on the floor today — so this is a plain "Load more" over
 * `useInfiniteQuery` rather than a new shared abstraction invented for one
 * screen.
 */

type SourceFilter = "all" | "activity" | "system";
type LevelFilter = "all" | "info" | "warn" | "error";

export function LogsView() {
  const [source, setSource] = useState<SourceFilter>("all");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [category, setCategory] = useState<(typeof EVENT_CATEGORIES)[number] | "all">("all");

  const query = trpc.admin.logs.useInfiniteQuery(
    {
      limit: 50,
      source,
      ...(level === "all" ? {} : { level }),
      ...(category === "all" ? {} : { category }),
    },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );

  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ScrollText className="h-6 w-6" aria-hidden />
          Logs
        </h1>
        {/* Which build produced these lines is the first thing you want when
            reading them — and answering it previously meant grepping a JS
            bundle inside the container. */}
        <span className="font-mono text-xs text-default-400">{buildLabel()}</span>
      </div>

      <p className="text-sm text-default-500">
        What this instance has been doing. Stack traces and framework noise stay in{" "}
        <code>docker compose logs</code>; this is the record of actions, failures, and every email
        with its outcome.
      </p>

      <div className="flex flex-wrap gap-2">
        <FilterGroup
          label="Source"
          value={source}
          options={[
            ["all", "Everything"],
            ["activity", "People"],
            ["system", "System"],
          ]}
          onChange={(v) => setSource(v as SourceFilter)}
        />
        <FilterGroup
          label="Level"
          value={level}
          options={[
            ["all", "Any"],
            ["error", "Errors"],
            ["warn", "Warnings"],
            ["info", "Info"],
          ]}
          onChange={(v) => setLevel(v as LevelFilter)}
        />
        <FilterGroup
          label="Area"
          value={category}
          options={[["all", "Any"], ...EVENT_CATEGORIES.map((c) => [c, c] as [string, string])]}
          onChange={(v) => setCategory(v as typeof category)}
        />
      </div>

      {/* Filtering by level or area excludes people-actions, because an audit
          row has neither — saying so beats silently showing a shorter list. */}
      {(level !== "all" || category !== "all") && source !== "system" ? (
        <p className="text-xs text-default-400">
          Level and area apply to system events only, so people-actions are hidden while either is
          set.
        </p>
      ) : null}

      <Card shadow="sm">
        <CardBody className="gap-0 p-0">
          {query.isPending ? (
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-6 rounded" />
              <Skeleton className="h-6 rounded" />
              <Skeleton className="h-6 rounded" />
            </div>
          ) : query.isError ? (
            <p className="p-4 text-sm text-danger">{query.error.message}</p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm text-default-500">Nothing recorded yet for this filter.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-divider">
              {rows.map((row) => (
                <li key={`${row.source}-${row.id}`} className="flex items-start gap-3 px-4 py-2.5">
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${levelColor(row.level)}`}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{logLabel(row)}</p>
                    <p className="text-xs text-default-400">
                      {row.at.toLocaleString()}
                      {row.category ? ` · ${row.category}` : ""}
                      {/* The relay's id, for cross-referencing smtp2go when an
                          email is "sent" but nobody received it — which is
                          exactly how this session went. */}
                      {typeof row.metadata.messageId === "string"
                        ? ` · ${row.metadata.messageId}`
                        : ""}
                    </p>
                  </div>
                  <Chip size="sm" variant="flat" className="shrink-0 font-mono text-xs">
                    {row.event}
                  </Chip>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {query.hasNextPage ? (
        <Button
          size="sm"
          variant="flat"
          className="self-center"
          isLoading={query.isFetchingNextPage}
          onPress={() => void query.fetchNextPage()}
        >
          Load more
        </Button>
      ) : rows.length > 0 ? (
        <p className="self-center text-xs text-default-400">That is everything.</p>
      ) : null}
    </div>
  );
}

function FilterGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-default-500">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map(([key, text]) => (
          <Chip
            key={key}
            size="sm"
            variant={value === key ? "solid" : "flat"}
            color={value === key ? "primary" : "default"}
            className="cursor-pointer capitalize"
            onClick={() => onChange(key)}
          >
            {text}
          </Chip>
        ))}
      </div>
    </div>
  );
}
