"use client";

import { useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  Chip,
  Input,
  Select,
  SelectItem,
  Skeleton,
  Switch,
  Textarea,
} from "@heroui/react";
import { RefreshCw, SlidersHorizontal } from "lucide-react";

import { trpc } from "../lib/trpc";

/**
 * apps/web/src/components/AiSettingsCard.tsx — how extraction is tuned (D-47).
 *
 * Sibling of `AiKeyCard`, and deliberately its opposite in one respect: nothing
 * here is a secret, so every value round-trips. The key card's input is
 * write-only because a key must never come back down; a model id must, or the
 * selector cannot show you what is set.
 *
 * ## The model list
 *
 * Refreshed at most once a UTC day, and only because someone opened this page.
 * The query reports `catalogStale` and this component fires the refresh
 * mutation once — see the `useRef` guard below, which exists because React
 * strict mode double-invokes effects in development and two refreshes on every
 * page open is exactly what "once per day" is meant to prevent. The server
 * re-checks staleness anyway, so the guard is politeness rather than
 * correctness.
 *
 * ## Why a warning rather than a filter
 *
 * Receipt extraction needs a model that can read an image. Models this app
 * knows are text-only are not offered at all. Models it does not RECOGNISE are
 * offered with a warning, because a brand-new family is far more likely to be
 * vision-capable than not — hiding it would leave an admin unable to select a
 * model that works perfectly well.
 */
export function AiSettingsCard() {
  const utils = trpc.useUtils();
  const status = trpc.admin.aiSettings.useQuery();

  // EDITS ONLY, not a copy of the server state. The rendered value is the edit
  // where one exists and the server's answer otherwise, so there is no effect
  // syncing one into the other — which is both a cascading-render hazard and
  // the usual way a form yanks a half-typed value out from under the cursor
  // when a refetch lands.
  const [edits, setEdits] = useState<Partial<Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const refreshedOnce = useRef(false);

  const server = status.data;
  const draft: Draft | null = server
    ? {
        modelPass1: edits.modelPass1 ?? server.modelPass1,
        modelPass2: edits.modelPass2 ?? server.modelPass2,
        escalateBelow: edits.escalateBelow ?? String(server.escalateBelow),
        concurrency: edits.concurrency ?? String(server.concurrency),
        rescanOnReview: edits.rescanOnReview ?? server.rescanOnReview,
        emailGate: edits.emailGate ?? server.emailGate,
        prompt: edits.prompt ?? server.prompt,
      }
    : null;

  const refresh = trpc.admin.refreshModelCatalog.useMutation({
    onSuccess: async (result) => {
      setRefreshNote(result.message);
      if (result.refreshed) await utils.admin.aiSettings.invalidate();
    },
    onError: (e) => setRefreshNote(e.message),
  });

  // Exactly once per page open, and only when the server says it is due.
  useEffect(() => {
    if (!status.data?.catalogStale || refreshedOnce.current) return;
    refreshedOnce.current = true;
    refresh.mutate({ force: false });
  }, [status.data?.catalogStale, refresh]);

  const save = trpc.admin.setAiSettings.useMutation({
    onSuccess: async (result) => {
      setError(null);
      setSaved(result.message);
      // Drop the local edits so the refetched server state becomes the
      // rendered value — otherwise a field the server normalised (a prompt
      // equal to the default, stored as "no override") would keep showing the
      // submitted text rather than what was actually saved.
      setEdits({});
      await utils.admin.aiSettings.invalidate();
    },
    onError: (e) => {
      setSaved(null);
      setError(e.message);
    },
  });

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setEdits((current) => ({ ...current, [key]: value }));
    setSaved(null);
    setError(null);
  };

  const busy = save.isPending || refresh.isPending;

  return (
    <Card shadow="sm">
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <SlidersHorizontal className="h-5 w-5" aria-hidden />
            Extraction settings
          </h2>
          {status.data ? <SourceChip source={status.data.source} /> : null}
        </div>

        <p className="text-sm text-default-500">
          Which models read your receipts, when a second opinion is worth paying for, and the
          instructions they are given. Everything except concurrency applies to the next receipt.
        </p>

        {status.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 rounded" />
            <Skeleton className="h-10 rounded" />
          </div>
        ) : null}

        {/* The error branch still renders the form. A settings screen that
            shows only an error is a settings screen you cannot use to fix the
            thing causing the error (AiKeyCard review finding M-1). */}
        {status.isError ? (
          <p className="text-sm text-danger">
            Could not load the current settings ({status.error.message}). You can still save new
            ones below.
          </p>
        ) : null}

        {draft ? (
          <>
            <div className="flex flex-col gap-3 sm:flex-row">
              <ModelSelect
                label="First pass"
                value={draft.modelPass1}
                models={status.data?.catalog.models ?? []}
                onChange={(v) => set("modelPass1", v)}
              />
              <ModelSelect
                label="Escalation model"
                value={draft.modelPass2}
                models={status.data?.catalog.models ?? []}
                onChange={(v) => set("modelPass2", v)}
              />
              <Button
                size="sm"
                variant="flat"
                className="self-end"
                isLoading={refresh.isPending}
                onPress={() => refresh.mutate({ force: true })}
                startContent={<RefreshCw className="h-4 w-4" aria-hidden />}
              >
                Refresh list
              </Button>
            </div>

            {/* The condition that silently switches off both the confidence
                ladder and the review rescan. Saying so is the difference
                between "escalation rate: 0%" reading as a bug and reading as
                the configuration. */}
            {draft.modelPass1 === draft.modelPass2 ? (
              <p className="text-xs text-warning">
                Both passes use the same model, so nothing will ever escalate — a second call to the
                same model costs the same again for the same answer. Pick a stronger escalation
                model to turn the second opinion on.
              </p>
            ) : null}

            {status.data?.catalog.fetchedAt ? (
              <p className="text-xs text-default-400">
                Model list updated {new Date(status.data.catalog.fetchedAt).toLocaleDateString()}.
              </p>
            ) : null}
            {refreshNote ? <p className="text-xs text-warning">{refreshNote}</p> : null}

            <div className="flex flex-col gap-3 sm:flex-row">
              <Input
                size="sm"
                label="Escalate below confidence"
                description="0 to 1. A reading less confident than this gets a second opinion."
                value={draft.escalateBelow}
                inputMode="decimal"
                onValueChange={(v) => set("escalateBelow", v)}
              />
              <Input
                size="sm"
                label="Concurrent extractions"
                description="Takes effect on the next restart."
                value={draft.concurrency}
                inputMode="numeric"
                onValueChange={(v) => set("concurrency", v.replace(/\D/g, ""))}
              />
            </div>

            <Switch
              size="sm"
              isSelected={draft.rescanOnReview}
              onValueChange={(v) => set("rescanOnReview", v)}
            >
              <span className="text-sm">
                Re-read with the escalation model when a receipt comes back needing review
              </span>
            </Switch>

            <Select
              size="sm"
              label="Hold the automatic email until"
              selectedKeys={new Set([draft.emailGate])}
              onSelectionChange={(keys) => {
                const [first] = Array.from(keys as Set<string>);
                if (first === "flags" || first === "flags_and_missing") set("emailGate", first);
              }}
            >
              <SelectItem key="flags">Warnings are resolved</SelectItem>
              <SelectItem key="flags_and_missing">
                Warnings are resolved and every missing field is filled in or dismissed
              </SelectItem>
            </Select>

            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">Extraction prompt</span>
                <div className="flex items-center gap-2">
                  {status.data && draft.prompt !== status.data.defaultPrompt ? (
                    <Chip size="sm" variant="flat" color="warning">
                      customised
                    </Chip>
                  ) : null}
                  <Button
                    size="sm"
                    variant="flat"
                    isDisabled={!status.data || draft.prompt === status.data.defaultPrompt}
                    onPress={() => status.data && set("prompt", status.data.defaultPrompt)}
                  >
                    Revert to default
                  </Button>
                </div>
              </div>
              <Textarea
                minRows={8}
                maxRows={24}
                value={draft.prompt}
                onValueChange={(v) => set("prompt", v)}
                classNames={{ input: "font-mono text-xs" }}
              />
              <p className="text-xs text-default-400">
                The instructions sent with every receipt. The output format itself is not editable —
                a change here can make readings worse, but it cannot break the app.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                color="primary"
                isLoading={save.isPending}
                isDisabled={busy}
                onPress={() => {
                  const escalateBelow = Number(draft.escalateBelow);
                  const concurrency = Number(draft.concurrency);
                  if (!Number.isFinite(escalateBelow) || escalateBelow < 0 || escalateBelow > 1) {
                    setError("Escalate below must be a number between 0 and 1.");
                    return;
                  }
                  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
                    setError("Concurrent extractions must be a whole number between 1 and 32.");
                    return;
                  }
                  save.mutate({
                    modelPass1: draft.modelPass1,
                    modelPass2: draft.modelPass2,
                    escalateBelow,
                    concurrency,
                    rescanOnReview: draft.rescanOnReview,
                    emailGate: draft.emailGate,
                    prompt: draft.prompt,
                  });
                }}
              >
                Save
              </Button>
              {saved ? <span className="text-sm text-success">{saved}</span> : null}
              {error ? <span className="text-sm text-danger">{error}</span> : null}
            </div>

            {status.data?.updatedAt ? (
              <p className="text-xs text-default-400">
                Last changed {new Date(status.data.updatedAt).toLocaleString()}
                {status.data.updatedByName ? ` by ${status.data.updatedByName}` : ""}.
              </p>
            ) : null}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

type Draft = {
  modelPass1: string;
  modelPass2: string;
  escalateBelow: string;
  concurrency: string;
  rescanOnReview: boolean;
  emailGate: "flags" | "flags_and_missing";
  prompt: string;
};

type CatalogModel = { id: string; displayName: string; vision: boolean | null };

/**
 * The selector, with the currently-set value guaranteed to be present.
 *
 * `mergeCatalog` on the server already folds the configured ids into the list,
 * but this keeps the guarantee local too: a value typed into `.env` that the
 * API has never heard of must still render as selected rather than as a blank
 * dropdown that silently rewrites the setting on the next save.
 */
function ModelSelect({
  label,
  value,
  models,
  onChange,
}: {
  label: string;
  value: string;
  models: CatalogModel[];
  onChange: (value: string) => void;
}) {
  const selectable = models.filter((m) => m.vision !== false);
  const options = selectable.some((m) => m.id === value)
    ? selectable
    : [...selectable, { id: value, displayName: value, vision: null }];

  return (
    <Select
      size="sm"
      label={label}
      className="flex-1"
      selectedKeys={new Set([value])}
      onSelectionChange={(keys) => {
        const [first] = Array.from(keys as Set<string>);
        if (first) onChange(first);
      }}
    >
      {options.map((model) => (
        <SelectItem key={model.id} textValue={model.displayName}>
          <span className="flex items-center gap-2">
            {model.displayName}
            {model.vision === null ? (
              <Chip size="sm" variant="flat" color="warning">
                unverified
              </Chip>
            ) : null}
          </span>
        </SelectItem>
      ))}
    </Select>
  );
}

function SourceChip({ source }: { source: "app_config" | "env" | "undecryptable" }) {
  if (source === "undecryptable") {
    return (
      <Chip size="sm" variant="flat" color="danger">
        stored settings unreadable — using defaults
      </Chip>
    );
  }
  return (
    <Chip size="sm" variant="flat" color={source === "app_config" ? "success" : "default"}>
      {source === "app_config" ? "set here" : "from the environment"}
    </Chip>
  );
}
