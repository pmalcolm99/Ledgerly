"use client";

import { useState } from "react";
import { Button, Card, CardBody, Chip, Select, SelectItem } from "@heroui/react";
import { UserPlus, Users, X } from "lucide-react";

import { trpc } from "../lib/trpc";

/**
 * apps/web/src/components/MemberManager.tsx — brief §3, "member management
 * for owners and full-access users".
 *
 * The whole section is hidden when the caller cannot manage members, and it
 * decides that by ASKING THE SERVER, not by inspecting a role client-side:
 * `users.list` is the same gate the mutations sit behind, so a FORBIDDEN from
 * it is exactly the population that would be refused anyway. Hiding a control
 * is a courtesy; the API refusing it is the security.
 */

const PERMISSION_LABELS = {
  read: "Can view",
  read_add: "Can add receipts",
  full: "Full access",
} as const;

export function MemberManager({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const members = trpc.members.list.useQuery({ projectId });

  // The manage gate, asked of the server. `retry: false` so a legitimate
  // FORBIDDEN is not retried as though it were a blip.
  const directory = trpc.users.list.useQuery(undefined, { retry: false });
  const canManage = directory.isSuccess;

  const [selectedUser, setSelectedUser] = useState<string>("");
  const [permission, setPermission] = useState<"read" | "read_add" | "full">("read_add");

  const add = trpc.members.add.useMutation({
    onSuccess: async () => {
      setSelectedUser("");
      await utils.members.list.invalidate({ projectId });
    },
  });
  const updatePermission = trpc.members.updatePermission.useMutation({
    onSuccess: () => utils.members.list.invalidate({ projectId }),
  });
  const remove = trpc.members.remove.useMutation({
    onSuccess: () => utils.members.list.invalidate({ projectId }),
  });

  if (members.isError) return null;

  const existing = new Set((members.data ?? []).map((member) => member.userId));
  const addable = (directory.data ?? []).filter((user) => !existing.has(user.id));

  return (
    <Card shadow="sm">
      <CardBody className="gap-3 p-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Users className="h-5 w-5" aria-hidden />
          People
        </h2>

        <ul className="flex flex-col divide-y divide-divider">
          {(members.data ?? []).map((member) => (
            <li key={member.userId} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{member.name}</p>
                <p className="truncate text-xs text-default-500">{member.email}</p>
              </div>

              {member.isProjectOwner ? (
                <Chip size="sm" variant="flat">
                  Owner
                </Chip>
              ) : canManage ? (
                <>
                  <Select
                    aria-label={`Permission for ${member.name}`}
                    size="sm"
                    className="max-w-[10rem]"
                    selectedKeys={new Set([member.permission])}
                    isDisabled={updatePermission.isPending}
                    onSelectionChange={(keys) => {
                      const [next] = Array.from(keys as Set<string>);
                      if (!next || next === member.permission) return;
                      updatePermission.mutate({
                        projectId,
                        userId: member.userId,
                        permission: next as "read" | "read_add" | "full",
                      });
                    }}
                  >
                    {Object.entries(PERMISSION_LABELS).map(([value, label]) => (
                      <SelectItem key={value}>{label}</SelectItem>
                    ))}
                  </Select>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    color="danger"
                    aria-label={`Remove ${member.name}`}
                    isDisabled={remove.isPending}
                    onPress={() => remove.mutate({ projectId, userId: member.userId })}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </>
              ) : (
                <Chip size="sm" variant="flat">
                  {PERMISSION_LABELS[member.permission]}
                </Chip>
              )}
            </li>
          ))}
        </ul>

        {canManage ? (
          addable.length === 0 ? (
            <p className="text-sm text-default-500">Everyone on this instance is already added.</p>
          ) : (
            <div className="flex flex-col gap-2 border-t border-divider pt-3 sm:flex-row sm:items-end">
              <Select
                aria-label="Person to add"
                size="sm"
                label="Add someone"
                className="sm:max-w-[14rem]"
                selectedKeys={selectedUser ? new Set([selectedUser]) : new Set()}
                onSelectionChange={(keys) => {
                  const [first] = Array.from(keys as Set<string>);
                  setSelectedUser(first ?? "");
                }}
              >
                {addable.map((user) => (
                  <SelectItem key={user.id}>{user.name}</SelectItem>
                ))}
              </Select>
              <Select
                aria-label="Permission"
                size="sm"
                label="Permission"
                className="sm:max-w-[12rem]"
                selectedKeys={new Set([permission])}
                onSelectionChange={(keys) => {
                  const [first] = Array.from(keys as Set<string>);
                  if (first) setPermission(first as "read" | "read_add" | "full");
                }}
              >
                {Object.entries(PERMISSION_LABELS).map(([value, label]) => (
                  <SelectItem key={value}>{label}</SelectItem>
                ))}
              </Select>
              <Button
                size="sm"
                color="primary"
                startContent={<UserPlus className="h-4 w-4" />}
                isDisabled={!selectedUser}
                isLoading={add.isPending}
                onPress={() => add.mutate({ projectId, userId: selectedUser, permission })}
              >
                Add
              </Button>
            </div>
          )
        ) : null}

        {add.isError ? (
          <p className="rounded bg-danger-50 p-3 text-sm text-danger">{add.error.message}</p>
        ) : null}
        {remove.isError ? (
          <p className="rounded bg-danger-50 p-3 text-sm text-danger">{remove.error.message}</p>
        ) : null}
      </CardBody>
    </Card>
  );
}
