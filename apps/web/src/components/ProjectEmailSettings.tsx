"use client";

import { Card, CardBody, Switch } from "@heroui/react";
import { Mail } from "lucide-react";

import { trpc } from "../lib/trpc";

/**
 * apps/web/src/components/ProjectEmailSettings.tsx — the per-project receipt
 * email toggle (D-44).
 *
 * ## Why it hides itself, and what it hides on
 *
 * `projects.update` requires `manage` on the project — `full` permission, or
 * being the instance owner. `projects.get` is NOT that gate: it succeeds for
 * anyone with `read`. Gating on it would show a read-only member a switch the
 * mutation then refuses with a NOT_FOUND, which reads as a bug rather than as
 * a permission.
 *
 * So the gate is the caller's own row in `members.list` (`full`), or their
 * live role from `auth.me` (`owner`) — the same two halves the server's own
 * `manage` scope is made of. `members.list` is already fetched on this page by
 * `MemberManager`, so this costs no extra round trip.
 *
 * That is still only a courtesy: the API refusing the mutation is the
 * security, exactly as `MemberManager` says. This just stops the UI making a
 * promise the server will not keep.
 *
 * ## Why this is the first client caller of `projects.update`
 *
 * It is. Every other project edit happens on the projects list. Adding
 * `emailReceipts` to that mutation was one line of input schema and one line
 * of patch — but it is also the field that decides whether receipt data leaves
 * the system, which is why it is the only one the mutation audits
 * unconditionally.
 */
export function ProjectEmailSettings({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const project = trpc.projects.get.useQuery({ id: projectId }, { retry: false });
  const me = trpc.auth.me.useQuery();
  const members = trpc.members.list.useQuery({ projectId });

  const canManage =
    me.data?.role === "owner" ||
    members.data?.some(
      (member) => member.userId === me.data?.id && member.permission === "full",
    ) === true;

  const smtp = trpc.admin.smtp.useQuery(undefined, {
    // Owner-only, so only the instance owner asks. Everyone else would get a
    // FORBIDDEN, and this is a hint, not a requirement — the toggle works
    // either way, it just cannot say whether a relay is set up.
    enabled: me.data?.role === "owner",
    retry: false,
  });

  const update = trpc.projects.update.useMutation({
    onSuccess: () => utils.projects.get.invalidate({ id: projectId }),
  });

  if (!project.isSuccess || !canManage) return null;

  // Optimistic while the round trip is in flight, so the switch does not
  // visibly snap back to the old value and then forward again.
  const enabled = update.isPending
    ? (update.variables?.emailReceipts ?? project.data.emailReceipts)
    : project.data.emailReceipts;

  const smtpMissing = smtp.isSuccess && smtp.data.source !== "app_config";

  return (
    <Card shadow="sm">
      <CardBody className="gap-2 p-4">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-default-500" />
          <h2 className="text-lg font-semibold">Receipt emails</h2>
        </div>

        <Switch
          size="sm"
          isSelected={enabled}
          isDisabled={update.isPending}
          onValueChange={(next) => update.mutate({ id: projectId, emailReceipts: next })}
        >
          <span className="text-sm">
            Email me each receipt
            <span className="block text-xs text-default-500">
              Sent to the project owner once per receipt, after the scan finishes — so the email
              contains the extracted fields rather than an empty shell.
            </span>
          </span>
        </Switch>

        {enabled && smtpMissing ? (
          <p className="text-sm text-warning">
            No SMTP settings are configured, so nothing will be sent. Set them up under Admin →
            Email.
          </p>
        ) : null}
        {update.isError ? <p className="text-sm text-danger">{update.error.message}</p> : null}
      </CardBody>
    </Card>
  );
}
