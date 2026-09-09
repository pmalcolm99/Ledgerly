"use client";

import NextLink from "next/link";
import { useState } from "react";
import {
  Button,
  Card,
  CardBody,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Skeleton,
  Textarea,
} from "@heroui/react";
import { formatMoneyDisplay } from "@ledgerly/shared/moneyDisplay";
import { FolderPlus, Receipt } from "lucide-react";

import { trpc } from "../lib/trpc";
import { ReviewBadge } from "./ReviewBadge";
import { formatDateRange } from "../lib/dates";

/**
 * The project list (brief §2): name, date range, total spend, receipt count,
 * and a badge for receipts needing review.
 */
export function ProjectList() {
  const [isCreateOpen, setCreateOpen] = useState(false);
  const projects = trpc.projects.list.useQuery({ status: "active" });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Projects</h1>
        <Button
          color="primary"
          startContent={<FolderPlus className="h-4 w-4" />}
          onPress={() => setCreateOpen(true)}
        >
          New project
        </Button>
      </div>

      {projects.isPending ? (
        <div className="flex flex-col gap-3" aria-busy>
          {[0, 1, 2].map((n) => (
            <Skeleton key={n} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : projects.isError ? (
        <Card>
          <CardBody className="gap-2 p-5">
            <p className="font-semibold">Couldn&apos;t load your projects.</p>
            <p className="text-sm text-default-500">{projects.error.message}</p>
            <Button size="sm" className="self-start" onPress={() => projects.refetch()}>
              Try again
            </Button>
          </CardBody>
        </Card>
      ) : projects.data.length === 0 ? (
        <Card>
          <CardBody className="items-center gap-3 p-8 text-center">
            <Receipt className="h-8 w-8 text-default-400" aria-hidden />
            <p className="text-lg font-semibold">No projects yet</p>
            <p className="max-w-sm text-sm text-default-500">
              A project groups the receipts for one job, trip, or period. Create one, then start
              photographing receipts into it.
            </p>
            <Button color="primary" onPress={() => setCreateOpen(true)}>
              Create your first project
            </Button>
          </CardBody>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {projects.data.map((project) => {
            // D-17: totals sum without regard to currency, which is only
            // meaningful while every receipt shares one. If a project ever
            // holds two, refuse to show a total rather than show a wrong one.
            const mixedCurrency = project.currencies.length > 1;
            return (
              <li key={project.id}>
                {/*
                  A real <a>, not `<Card isPressable as={NextLink}>`. HeroUI's
                  pressable Card renders a div with role="button" and drops the
                  anchor, which loses open-in-new-tab, middle-click, "copy link
                  address", and the link semantics a screen reader announces.
                  Wrapping the card in a plain NextLink keeps all of that —
                  the same shape ReceiptRow uses.
                */}
                <NextLink href={`/projects/${project.id}`} className="block">
                  <Card className="w-full transition-colors hover:bg-content2" shadow="sm">
                    <CardBody className="gap-2 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <h2 className="text-lg font-semibold">{project.name}</h2>
                        {project.needsReviewCount > 0 ? (
                          <ReviewBadge state="needs-review" count={project.needsReviewCount} />
                        ) : null}
                      </div>
                      <p className="text-sm text-default-500">
                        {formatDateRange(project.startDate, project.endDate)}
                      </p>
                      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                        <span className="text-xl font-semibold tabular-nums">
                          {mixedCurrency
                            ? "Mixed currencies"
                            : formatMoneyDisplay(project.totalSpend)}
                        </span>
                        <span className="text-sm text-default-500">
                          {project.receiptCount}{" "}
                          {project.receiptCount === 1 ? "receipt" : "receipts"}
                        </span>
                        {project.receiptsMissingTotal > 0 ? (
                          // `sum` skips NULLs, so the figure above understates.
                          // Saying so is better than a quietly wrong total.
                          <span className="text-xs text-warning">
                            {project.receiptsMissingTotal} without a total
                          </span>
                        ) : null}
                      </div>
                    </CardBody>
                  </Card>
                </NextLink>
              </li>
            );
          })}
        </ul>
      )}

      <CreateProjectModal isOpen={isCreateOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreateProjectModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const create = trpc.projects.create.useMutation({
    onSuccess: async () => {
      await utils.projects.list.invalidate();
      setName("");
      setDescription("");
      setStartDate("");
      setEndDate("");
      onClose();
    },
  });

  // `disableAnimation`: HeroUI's overlay animation leaves the wrapper pinned
  // at the framer-motion EXIT variant — inline `opacity: 0` plus a translate —
  // and never plays the enter transition, so the dialog ends up mounted,
  // focus-trapping the page, and invisible. Reproduced in Chrome and WebKit,
  // on framer-motion 11 and 12. See providers.tsx.
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      placement="center"
      disableAnimation
      className="z-[9999]"
    >
      <ModalContent>
        {/* One form, one submit target. Never nest a <form> — browsers drop
            the inner tag silently and adopt its button into the outer form
            (FORKD_LESSONS.md). */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({
              name,
              description: description || undefined,
              startDate: startDate || undefined,
              endDate: endDate || undefined,
            });
          }}
        >
          <ModalHeader>New project</ModalHeader>
          <ModalBody className="gap-3">
            <Input
              label="Name"
              value={name}
              onValueChange={setName}
              isRequired
              autoFocus
              maxLength={200}
            />
            <Textarea
              label="Description"
              value={description}
              onValueChange={setDescription}
              maxLength={4000}
            />
            <div className="flex gap-3">
              <Input
                type="date"
                label="Start date"
                value={startDate}
                onValueChange={setStartDate}
              />
              <Input type="date" label="End date" value={endDate} onValueChange={setEndDate} />
            </div>
            {create.isError ? (
              <p className="rounded bg-danger-50 p-3 text-sm text-danger">{create.error.message}</p>
            ) : null}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onClose} type="button">
              Cancel
            </Button>
            <Button
              color="primary"
              type="submit"
              isLoading={create.isPending}
              isDisabled={!name.trim()}
            >
              Create
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
