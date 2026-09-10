"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card, CardBody, Chip, Input, Skeleton } from "@heroui/react";
import { Database, Download, HardDriveDownload } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@ledgerly/api";

import { trpc } from "../lib/trpc";

/**
 * apps/web/src/components/BackupsCard.tsx — Phase 9's admin surface (task 9.5,
 * and the `MASTER_KEY` warning of task 9.7).
 *
 * Extracted out of `AdminView.tsx`, where it was a disabled button behind a
 * "Backups arrive in phase 9" tooltip.
 *
 * Mirrors `SmtpCard.tsx`'s conventions throughout: inline feedback rather than
 * toasts (this app has no toast system), one `busy` flag across every mutation
 * on the card, `utils.admin.*.invalidate()` after a write, and — the important
 * one — **the schedule form renders on the query's error branch too**. The one
 * interesting way `backupStatus` fails is a `MASTER_KEY` that no longer
 * decrypts the stored row, which is exactly when an operator needs to be able
 * to replace it. Rendering only the error would leave `psql` as the way out.
 *
 * ## What this card is really for
 *
 * Not the button. The button is the easy part. This card exists because a
 * backup system that fails silently is worse than none, so its job is to make
 * every way that can happen visible on one screen:
 *
 * - no schedule configured at all;
 * - a schedule configured whose stored value cannot be decrypted;
 * - a schedule configured and **nothing registered to run it** (Redis holds the
 *   scheduler and no backup restores Redis, so this is an ordinary state after
 *   a `redis_data` loss, not an exotic one);
 * - the last run having failed, with its reason;
 * - and the fact that images are excluded, which is the default.
 */
export function BackupsCard() {
  const utils = trpc.useUtils();
  const status = trpc.admin.backupStatus.useQuery(undefined, {
    // Poll only while something is genuinely in flight, and stop the moment it
    // is not — `lib/extractionPolling.ts`'s rule, for the same reason: this
    // screen is reached over a Cloudflare Tunnel from a phone, and a permanent
    // interval is a real battery cost.
    refetchInterval: (query) => (query.state.data?.last?.status === "running" ? 3_000 : false),
  });
  const history = trpc.admin.backups.useQuery(undefined, {
    refetchInterval: (query) =>
      query.state.data?.some((row) => row.status === "running") ? 3_000 : false,
  });

  /**
   * The backup this session started and is watching.
   *
   * "Back up now" cannot download anything itself — the archive does not exist
   * until the job finishes (D-45), and the job is deliberately asynchronous. So
   * the id is remembered and the download fires when that row turns `complete`,
   * which is the closest honest equivalent of "click, get a file".
   *
   * It is never cleared: once the row finishes it keeps pointing at it, which
   * is what makes the completion message below a derived value rather than
   * something an effect has to write. Starting another backup replaces it.
   */
  const [awaitingId, setAwaitingId] = useState<string | null>(null);
  // A ref, not state: the download must fire exactly once per completed backup,
  // and deriving "have I already done this" from render state would fire again
  // on any unrelated re-render between the download and the next refetch.
  const downloaded = useRef<Set<string>>(new Set());

  const create = trpc.admin.createBackup.useMutation({
    onSuccess: async (result) => {
      setAwaitingId(result.backupId);
      await Promise.all([utils.admin.backups.invalidate(), utils.admin.backupStatus.invalidate()]);
    },
  });

  const awaitingRow = awaitingId
    ? history.data?.find((entry) => entry.id === awaitingId)
    : undefined;
  const finishedRow = awaitingRow && awaitingRow.status !== "running" ? awaitingRow : null;

  /**
   * Derived, not stored.
   *
   * An earlier version kept this in state and wrote it from an effect, which
   * `react-hooks/set-state-in-effect` correctly flags — setting state
   * synchronously in an effect is a cascading render, and the same rule caught
   * the theme switcher in the post-Phase-8 batch. Everything here is a pure
   * function of the mutation and the row it is watching, so there is nothing
   * for an effect to write.
   */
  const message: { ok: boolean; text: string } | null = create.isError
    ? { ok: false, text: create.error.message }
    : finishedRow
      ? finishedRow.status === "complete"
        ? { ok: true, text: "Backup complete. The download should have started." }
        : { ok: false, text: `The backup failed: ${finishedRow.error ?? "unknown reason"}` }
      : awaitingId
        ? { ok: true, text: "Backup started. The download begins when it finishes." }
        : null;

  // The one effect on this card, and it writes no state — handing a file to the
  // browser is a genuine external side effect, which is what an effect is for.
  useEffect(() => {
    if (finishedRow?.status !== "complete") return;
    if (downloaded.current.has(finishedRow.id)) return;
    downloaded.current.add(finishedRow.id);
    startDownload(finishedRow.id);
  }, [finishedRow]);

  const busy = create.isPending || status.data?.last?.status === "running";

  return (
    <Card shadow="sm">
      <CardBody className="gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Database className="h-5 w-5" aria-hidden />
            Backups
          </h2>
          <Button
            size="sm"
            variant="flat"
            isDisabled={busy}
            isLoading={create.isPending}
            startContent={<HardDriveDownload className="h-4 w-4" />}
            onPress={() => create.mutate()}
          >
            {status.data?.last?.status === "running" ? "Backing up…" : "Back up now"}
          </Button>
        </div>

        {status.isPending ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : (
          <>
            {status.isError ? (
              <p className="text-sm text-danger">
                Couldn&apos;t read the backup status: {status.error.message}
              </p>
            ) : (
              <BackupSummary data={status.data} />
            )}
            <ScheduleForm
              initialCron={status.isError ? "" : (status.data.schedule.cron ?? "")}
              hasStoredSchedule={!status.isError && status.data.schedule.source !== "none"}
              onChanged={async () => {
                await Promise.all([
                  utils.admin.backupStatus.invalidate(),
                  utils.admin.backups.invalidate(),
                ]);
              }}
            />
          </>
        )}

        {message ? (
          <p className={`text-sm ${message.ok ? "text-success" : "text-danger"}`}>{message.text}</p>
        ) : null}

        {/*
          Task 9.7. Not a footnote: an operator who keeps only archives and
          loses MASTER_KEY restores every receipt and cannot read a single
          stored setting — and finds that out at the worst possible moment.
        */}
        <p className="rounded-lg border border-warning-200 bg-warning-50/50 p-3 text-xs">
          <strong>Back up MASTER_KEY separately.</strong> Archives contain the settings table with
          its values still encrypted, and nothing that can decrypt them. Keep{" "}
          <code>MASTER_KEY</code> somewhere else — a password manager — or a restored instance will
          need its Claude API key and SMTP password entered again by hand.
        </p>

        <h3 className="mt-1 text-sm font-semibold text-default-600">History</h3>
        {history.isPending ? (
          <Skeleton className="h-16 rounded-lg" />
        ) : history.isError ? (
          <p className="text-sm text-danger">{history.error.message}</p>
        ) : history.data.length === 0 ? (
          <p className="rounded-lg border border-warning-200 bg-warning-50/50 p-3 text-sm">
            <strong>No backups have ever run.</strong> Press &ldquo;Back up now&rdquo;, and set a
            schedule below so it does not depend on anyone remembering.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-divider text-sm">
            {history.data.map((backup) => (
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
                {/* min-w-0 is not decoration: a flex item defaults to
                    min-width:auto and refuses to shrink, so `truncate` alone
                    does nothing and the row wraps instead (the admin-screen bug
                    fixed in the post-Phase-8 batch). */}
                <span className="min-w-0 flex-1 truncate text-default-500">
                  {backup.kind}
                  {backup.imagesIncluded ? " + images" : ""}
                  {backup.error ? ` — ${backup.error}` : ""}
                </span>
                <span className="shrink-0 tabular-nums">{formatSize(backup.sizeBytes)}</span>
                <span className="shrink-0 text-xs text-default-400">
                  {backup.startedAt.toLocaleString()}
                </span>
                <Button
                  size="sm"
                  variant="light"
                  isIconOnly
                  aria-label="Download this backup"
                  isDisabled={!backup.hasArtifact || backup.status !== "complete"}
                  onPress={() => startDownload(backup.id)}
                >
                  <Download className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Hands the archive to the browser.
 *
 * A synthetic `target="_blank"` anchor, copying `ExportButton.tsx` for the
 * reasons argued there at length: `window.location.assign` navigates the only
 * document an installed iOS PWA has and traps the user with no way back, and
 * `window.open` with `noopener` returns null BY SPEC so any fallback fires
 * every time and downloads twice. No `download` attribute — the filename comes
 * from the server's `Content-Disposition`, which encodes the backup's
 * timestamp; `download` would override it with the URL's last segment, which
 * is the word "download".
 */
function startDownload(backupId: string): void {
  const link = document.createElement("a");
  link.href = `/api/admin/backups/${backupId}/download`;
  link.target = "_blank";
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/** The `admin.backupStatus` payload, taken from the router rather than from a
 *  hook's return type — `useQuery`'s no-argument overload widens `data` to `{}`
 *  and the fields vanish. */
type BackupStatus = inferRouterOutputs<AppRouter>["admin"]["backupStatus"];

function BackupSummary({ data }: { data: BackupStatus }) {
  const { last, schedule, scheduler } = data;
  // `scheduler === null` means we could not ask (no Redis wired into this
  // context), which must not be reported as "nothing is going to run". Only a
  // definite `registered: false` alongside a configured cron is a finding.
  const scheduleBroken = schedule.source === "app_config" && scheduler?.registered === false;
  // Registered is not the same as registered WITH THE SAVED CRON. `Save`
  // commits to `app_config` before it touches Redis, so a failed reschedule
  // leaves the old scheduler in place — and every other indicator on this card
  // would read healthy while backups ran at the old time forever.
  const schedulePatternStale =
    schedule.source === "app_config" &&
    scheduler?.registered === true &&
    scheduler.pattern !== null &&
    scheduler.pattern !== schedule.cron;
  // The question no other field on this card answers: has a backup actually
  // HAPPENED lately? "Next scheduled run" is always in the future because it is
  // computed from the cron, and "Last backup" is a bare timestamp nobody
  // subtracts in their head. A worker that is not consuming its queue, or a
  // host that is off at 3am every night, produces a screen where every
  // individual figure looks fine.
  const overdue =
    schedule.source === "app_config" &&
    schedule.nextRunAt !== null &&
    isOverdue(last?.startedAt ?? null, schedule.nextRunAt, data.retentionDays);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        <div>
          <p className="text-xs text-default-500">Last backup</p>
          {last ? (
            <p className="text-sm">
              <span className="font-semibold">{last.startedAt.toLocaleString()}</span>{" "}
              <span className="text-default-500">
                — {last.status}
                {last.status === "complete" ? `, ${formatSize(last.sizeBytes)}` : ""}
                {last.error ? `, ${last.error}` : ""}
              </span>
            </p>
          ) : (
            <p className="text-sm text-default-500">Never</p>
          )}
        </div>
        <div>
          <p className="text-xs text-default-500">Next scheduled run</p>
          <p className="text-sm">
            {schedule.source === "undecryptable" ? (
              <span className="text-danger">Unknown — the stored schedule cannot be read</span>
            ) : schedule.nextRunAt ? (
              <span className="font-semibold">{schedule.nextRunAt.toLocaleString()}</span>
            ) : (
              <span className="text-warning">Not scheduled</span>
            )}
          </p>
        </div>
        <div>
          <p className="text-xs text-default-500">Contents</p>
          <p className="text-sm">
            Database{data.includeImages ? " and images" : " only"}
            <span className="block text-xs text-default-500">
              kept {data.retentionDays} days
              {data.includeImages ? "" : " · BACKUP_INCLUDE_IMAGES=false"}
            </span>
          </p>
        </div>
      </div>

      {schedule.source === "undecryptable" ? (
        <p className="rounded-lg border border-danger-200 bg-danger-50/50 p-3 text-sm">
          <strong>The stored schedule cannot be decrypted.</strong> <code>MASTER_KEY</code> has
          changed since it was saved, so <strong>no scheduled backup is running</strong>. Restore
          the original key, or set the schedule again below — saving overwrites the unreadable row.
        </p>
      ) : null}

      {scheduleBroken ? (
        <p className="rounded-lg border border-danger-200 bg-danger-50/50 p-3 text-sm">
          <strong>A schedule is saved but nothing is registered to run it.</strong> The scheduler
          lives in Redis and is not part of any backup, so this is what a Redis reset looks like.
          Save the schedule again below, or restart the app — either re-registers it.
        </p>
      ) : null}

      {schedulePatternStale ? (
        <p className="rounded-lg border border-danger-200 bg-danger-50/50 p-3 text-sm">
          <strong>The saved schedule is not the one that is running.</strong> Redis still holds{" "}
          <code>{scheduler?.pattern}</code> while <code>{schedule.cron}</code> is saved — the last
          change was written but never applied. Press Save again to reconcile them.
        </p>
      ) : null}

      {overdue ? (
        <p className="rounded-lg border border-danger-200 bg-danger-50/50 p-3 text-sm">
          <strong>No backup has run recently, though one is scheduled.</strong>{" "}
          {last ? `The last one started ${last.startedAt.toLocaleString()}.` : "None has ever run."}{" "}
          Something is stopping the scheduled job from finishing — check the app logs, and press
          &ldquo;Back up now&rdquo; to see the failure directly.
        </p>
      ) : null}

      {schedule.source === "none" ? (
        <p className="rounded-lg border border-warning-200 bg-warning-50/50 p-3 text-sm">
          <strong>No scheduled backups.</strong> Nothing will be backed up unless someone presses
          the button. Set a cron below — <code>0 3 * * *</code> is nightly at 3am.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The cron field.
 *
 * Deliberately a raw cron expression rather than a friendlier time picker. The
 * value is handed straight to BullMQ, and a picker would either constrain what
 * the operator can express or become a second syntax to translate — and a
 * mistranslation here means backups silently run at the wrong time, or not at
 * all. Showing the real thing, validating it server-side, and reporting the
 * next fire time is more honest than hiding it.
 */
function ScheduleForm({
  initialCron,
  hasStoredSchedule,
  onChanged,
}: {
  initialCron: string;
  hasStoredSchedule: boolean;
  onChanged: () => Promise<void>;
}) {
  const [cron, setCron] = useState(initialCron);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const save = trpc.admin.setBackupSchedule.useMutation({
    onSuccess: async (result) => {
      setError(null);
      setSaved(
        result.ok
          ? `Scheduled. Next run ${result.nextRunAt.toLocaleString()}.`
          : // Not an error: the row is written and will take effect on the next
            // restart. Saying "failed" would invite a retry of something that
            // does not need retrying.
            result.message,
      );
      await onChanged();
    },
    onError: (e) => {
      setSaved(null);
      setError(e.message);
    },
  });

  const clear = trpc.admin.clearBackupSchedule.useMutation({
    onSuccess: async () => {
      setCron("");
      setError(null);
      setSaved("Scheduled backups are off.");
      await onChanged();
    },
    onError: (e) => setError(e.message),
  });

  const busy = save.isPending || clear.isPending;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Input
          size="sm"
          label="Nightly schedule (cron)"
          placeholder="0 3 * * *"
          className="flex-1"
          value={cron}
          onValueChange={(value) => {
            setCron(value);
            setSaved(null);
            setError(null);
          }}
          isDisabled={busy}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            color="primary"
            isDisabled={busy || cron.trim().length === 0}
            isLoading={save.isPending}
            onPress={() => save.mutate({ cron: cron.trim() })}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="flat"
            isDisabled={busy || !hasStoredSchedule}
            isLoading={clear.isPending}
            onPress={() => clear.mutate()}
          >
            Turn off
          </Button>
        </div>
      </div>
      <p className="text-xs text-default-500">
        Five fields — minute, hour, day, month, weekday — in the server&apos;s timezone, which is
        UTC unless <code>TZ</code> is set. Changing it takes effect immediately; no restart.
      </p>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {saved ? <p className="text-sm text-success">{saved}</p> : null}
    </div>
  );
}

/**
 * Whether the last backup is old enough that the schedule is evidently not
 * working.
 *
 * The cron's interval is inferred from its own next fire time rather than
 * parsed — `nextRunAt - now` is one period, near enough, and it avoids shipping
 * a cron parser to the browser to answer a question that only needs to be
 * roughly right. Two missed intervals plus a day of slack, so a nightly backup
 * has to be more than three days late before this fires: late enough that
 * nobody can call it noise, early enough to matter. Never fires past the
 * retention window, where an old backup has simply been pruned.
 */
function isOverdue(lastStartedAt: Date | null, nextRunAt: Date, retentionDays: number): boolean {
  const period = nextRunAt.getTime() - Date.now();
  if (period <= 0) return false;
  const tolerance = Math.min(period * 2 + 86_400_000, retentionDays * 86_400_000);
  if (!lastStartedAt) {
    // Nothing has ever run. Only a finding once a scheduled run should have
    // happened by now — a schedule saved a minute ago is not a failure.
    return false;
  }
  return Date.now() - lastStartedAt.getTime() > tolerance;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}
