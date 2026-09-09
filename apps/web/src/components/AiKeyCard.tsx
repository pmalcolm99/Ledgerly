"use client";

import { useState } from "react";
import { Button, Card, CardBody, Chip, Input, Skeleton } from "@heroui/react";
import { KeyRound } from "lucide-react";

import { trpc } from "../lib/trpc";

/**
 * apps/web/src/components/AiKeyCard.tsx — the Claude API key, settable by the
 * instance owner (D-39).
 *
 * ## What this screen never does
 *
 * It never displays the key. There is no procedure that returns it — `admin.aiKey`
 * returns a type with no field capable of holding one (see
 * `packages/api/src/aiKey.ts`), so this is enforced on the server rather than
 * by this component remembering not to render something.
 *
 * The input is therefore write-only: it starts empty every time, and an
 * existing key is represented by its last four characters. That is the same
 * disclosure a card's `last4` makes, and it is what lets you tell "the key I
 * pasted" from "some other key" without the value ever reaching a browser.
 *
 * `type="password"` and `autoComplete="off"` keep it out of the browser's
 * password manager and out of a shoulder-surfer's view while typing; neither
 * is a security control on its own, which is why the real one is that the
 * value only ever travels in one direction.
 */
export function AiKeyCard() {
  const utils = trpc.useUtils();
  const status = trpc.admin.aiKey.useQuery();

  const [rawDraft, setRawDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const draft = rawDraft;
  const setDraft = (value: string): void => {
    setRawDraft(value);
    setSaved(false);
    setError(null);
  };

  const onSettled = async () => {
    setRawDraft("");
    await utils.admin.aiKey.invalidate();
  };

  const save = trpc.admin.setAiKey.useMutation({
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      await onSettled();
    },
    onError: (e) => {
      setSaved(false);
      setError(e.message);
    },
  });

  const clear = trpc.admin.clearAiKey.useMutation({
    onSuccess: async () => {
      setError(null);
      setSaved(false);
      await onSettled();
    },
    onError: (e) => setError(e.message),
  });

  const busy = save.isPending || clear.isPending;

  return (
    <Card shadow="sm">
      <CardBody className="gap-3 p-4">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-default-500" />
          <h2 className="text-lg font-semibold">Claude API key</h2>
          {status.isPending ? null : <SourceChip source={status.data?.source ?? "none"} />}
        </div>

        {status.isPending ? (
          <Skeleton className="h-16 rounded-lg" />
        ) : status.isError ? (
          /* The status query can only fail in ways that leave this screen the
             ONLY way out — so it still has to offer a way out. Save and Clear
             both work against a row that cannot be read, because neither
             reads it. Rendering just the error here would mean an operator
             whose MASTER_KEY no longer matches has to reach for psql. */
          <>
            <p className="text-sm text-danger">
              Couldn&apos;t read the key&apos;s status: {status.error.message}
            </p>
            <p className="text-sm text-default-500">
              You can still replace or clear the stored key below — neither reads the existing
              value.
            </p>
            <KeyForm
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              label="API key"
              onSave={() => save.mutate({ apiKey: draft })}
              saving={save.isPending}
              onClear={() => clear.mutate()}
              clearing={clear.isPending}
              showClear
            />
            {error ? <p className="text-sm text-danger">{error}</p> : null}
          </>
        ) : (
          <>
            <p className="text-sm text-default-500">
              {status.data.source === "undecryptable" ? (
                <>
                  A key is stored, but it cannot be decrypted —{" "}
                  <code className="text-xs">MASTER_KEY</code> does not match the one it was saved
                  with. Restore the original <code className="text-xs">MASTER_KEY</code>, or clear
                  the stored key and paste a new one. Extraction is stopped until then, and it will
                  NOT silently fall back to the environment variable.
                </>
              ) : status.data.source === "none" ? (
                <>
                  No key is configured, so receipt extraction will fail and uploads will land in the
                  review queue with their images intact. Paste a key below to start extracting.
                </>
              ) : status.data.source === "env" ? (
                <>
                  Using <code className="text-xs">ANTHROPIC_API_KEY</code> from the environment{" "}
                  <span className="tabular-nums">{status.data.hint}</span>. Saving a key here
                  overrides it without touching your <code className="text-xs">.env</code>.
                </>
              ) : (
                <>
                  Saved here <span className="tabular-nums">{status.data.hint}</span>
                  {status.data.updatedByName ? ` by ${status.data.updatedByName}` : null}
                  {status.data.updatedAt
                    ? ` on ${new Date(status.data.updatedAt).toLocaleDateString()}`
                    : null}
                  . This overrides the environment variable.
                </>
              )}
            </p>

            <KeyForm
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              label={status.data.source === "app_config" ? "Replace key" : "API key"}
              onSave={() => save.mutate({ apiKey: draft })}
              saving={save.isPending}
              onClear={() => clear.mutate()}
              clearing={clear.isPending}
              showClear={
                status.data.source === "app_config" || status.data.source === "undecryptable"
              }
            />

            {/* The one thing an operator most needs to know before pressing
                Clear: whether it disables extraction or falls back. */}
            {status.data.source === "app_config" ? (
              <p className="text-xs text-default-500">
                {status.data.hasEnvFallback
                  ? "Clearing falls back to ANTHROPIC_API_KEY from the environment."
                  : "Clearing leaves no key configured — extraction will stop until one is set."}
              </p>
            ) : null}

            {error ? <p className="text-sm text-danger">{error}</p> : null}
            {saved ? (
              <p className="text-sm text-success">
                Saved. New uploads use it immediately — the worker re-reads the key per receipt, so
                no restart is needed.
                {save.data && save.data.requeued > 0
                  ? ` Re-extracting ${save.data.requeued} receipt${save.data.requeued === 1 ? "" : "s"} that had failed for want of a key.`
                  : null}
              </p>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function SourceChip({ source }: { source: "app_config" | "env" | "none" | "undecryptable" }) {
  if (source === "undecryptable") {
    return (
      <Chip size="sm" variant="flat" color="danger">
        Cannot be decrypted
      </Chip>
    );
  }
  if (source === "none") {
    return (
      <Chip size="sm" variant="flat" color="warning">
        Not configured
      </Chip>
    );
  }
  return (
    <Chip size="sm" variant="flat" color="success">
      {source === "app_config" ? "Set here" : "From environment"}
    </Chip>
  );
}

/** The write-only key form. Extracted so the error branch above can render the
 *  same recovery controls as the normal one — the whole point of M-1's fix is
 *  that they exist on BOTH paths. */
function KeyForm(props: {
  draft: string;
  setDraft: (value: string) => void;
  busy: boolean;
  label: string;
  onSave: () => void;
  saving: boolean;
  onClear: () => void;
  clearing: boolean;
  showClear: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <Input
        type="password"
        size="sm"
        label={props.label}
        placeholder="sk-ant-..."
        autoComplete="off"
        value={props.draft}
        onValueChange={props.setDraft}
        isDisabled={props.busy}
        className="flex-1"
      />
      <Button
        size="sm"
        color="primary"
        isDisabled={props.draft.trim().length === 0 || props.busy}
        isLoading={props.saving}
        onPress={props.onSave}
      >
        Save
      </Button>
      {props.showClear ? (
        <Button
          size="sm"
          variant="flat"
          isDisabled={props.busy}
          isLoading={props.clearing}
          onPress={props.onClear}
        >
          Clear
        </Button>
      ) : null}
    </div>
  );
}
