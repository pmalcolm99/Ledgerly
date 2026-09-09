"use client";

import { useState } from "react";
import { Button, Card, CardBody, Chip, Input, Skeleton } from "@heroui/react";
import { Lock, Plus, Trash2 } from "lucide-react";

import { trpc } from "../lib/trpc";

/**
 * apps/web/src/components/CategoryManager.tsx — task 7.6.
 *
 * Categories are instance-wide (D-20), so this is a settings screen rather
 * than something inside a project.
 *
 * The 13 seeded categories are `is_system` and cannot be renamed or deleted,
 * which keeps the meaning of an old export stable. They are shown with a lock
 * rather than hidden — the taxonomy is more legible when you can see the whole
 * thing and understand why part of it is fixed.
 */
export function CategoryManager() {
  const utils = trpc.useUtils();
  const categories = trpc.categories.list.useQuery({ includeCounts: true });
  const [name, setName] = useState("");

  const create = trpc.categories.create.useMutation({
    onSuccess: async () => {
      setName("");
      await utils.categories.list.invalidate();
    },
  });
  const remove = trpc.categories.delete.useMutation({
    onSuccess: () => utils.categories.list.invalidate(),
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold">Categories</h1>
        <p className="text-sm text-default-500">
          Shared across every project on this instance, so reports and exports mean the same thing
          over time.
        </p>
      </div>

      <Card shadow="sm">
        <CardBody className="gap-2 p-4">
          <div className="flex flex-wrap items-end gap-2">
            <Input
              label="New category"
              size="sm"
              className="min-w-[12rem] flex-1"
              value={name}
              onValueChange={setName}
              maxLength={100}
              onKeyDown={(event) => {
                if (event.key === "Enter" && name.trim()) create.mutate({ name: name.trim() });
              }}
            />
            <Button
              size="sm"
              color="primary"
              startContent={<Plus className="h-4 w-4" />}
              isDisabled={!name.trim()}
              isLoading={create.isPending}
              onPress={() => create.mutate({ name: name.trim() })}
            >
              Add
            </Button>
          </div>
          {create.isError ? (
            <p className="rounded bg-danger-50 p-2 text-sm text-danger">{create.error.message}</p>
          ) : null}
        </CardBody>
      </Card>

      {remove.isError ? (
        // The "still used by N items" refusal lands here. CONFLICT is a
        // client-safe code, so the count survives the error formatter.
        <p className="rounded bg-danger-50 p-3 text-sm text-danger">{remove.error.message}</p>
      ) : null}

      {categories.isPending ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : categories.isError ? (
        <p className="rounded bg-danger-50 p-3 text-sm text-danger">{categories.error.message}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-divider rounded-xl border border-divider">
          {categories.data.map((category) => (
            <li key={category.id} className="flex items-center gap-3 p-3">
              <span
                aria-hidden
                className="h-3 w-3 shrink-0 rounded-full border border-divider"
                style={{ background: category.color ?? "transparent" }}
              />
              <span className="min-w-0 flex-1 truncate">{category.name}</span>
              <span className="shrink-0 text-xs text-default-400">
                {category.itemCount} {category.itemCount === 1 ? "item" : "items"}
              </span>
              {category.isSystem ? (
                <Chip
                  size="sm"
                  variant="flat"
                  startContent={<Lock className="h-3 w-3" />}
                  title="Built in, so old exports keep their meaning"
                >
                  Built in
                </Chip>
              ) : (
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  color="danger"
                  aria-label={`Delete ${category.name}`}
                  isDisabled={remove.isPending}
                  onPress={() => remove.mutate({ id: category.id })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
