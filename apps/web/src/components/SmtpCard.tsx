"use client";

import { useState } from "react";
import { Button, Card, CardBody, Chip, Input, Skeleton, Switch } from "@heroui/react";
import { Mail } from "lucide-react";

import { trpc } from "../lib/trpc";

/**
 * apps/web/src/components/SmtpCard.tsx — the SMTP settings (D-44).
 *
 * Mirrors `AiKeyCard.tsx`, including the two decisions that card learned the
 * hard way:
 *
 * 1. **The form renders on the error branch too.** The status query can fail
 *    in exactly one interesting way — `MASTER_KEY` no longer decrypts the
 *    stored row — and that is precisely when the operator needs this screen.
 *    Rendering only the error would leave `psql` as the way out.
 * 2. **The password is write-only.** `admin.smtp` returns a type with no
 *    password field (see `packages/api/src/smtp.ts`), so an existing password
 *    is represented by its last four characters and nothing else.
 *
 * The consequence of (2) is the blank-means-unchanged rule: submitting with
 * the password box empty keeps the stored password. Without it, correcting a
 * typo in the port would silently wipe authentication, and the failure would
 * show up hours later as mail that stopped arriving.
 */
export function SmtpCard() {
  const utils = trpc.useUtils();
  const status = trpc.admin.smtp.useQuery();

  return (
    <Card shadow="sm">
      <CardBody className="gap-3 p-4">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-default-500" />
          <h2 className="text-lg font-semibold">Email (SMTP)</h2>
          {status.isPending ? null : <SourceChip source={status.data?.source ?? "none"} />}
        </div>

        <p className="text-sm text-default-500">
          Used to send receipt emails. Any relay works — smtp2go, Postmark, SES — and nothing is
          sent until a project turns receipt emails on, or someone emails a receipt by hand.
        </p>

        {status.isPending ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : status.isError ? (
          <>
            <p className="text-sm text-danger">
              Couldn&apos;t read the settings: {status.error.message}
            </p>
            <p className="text-sm text-default-500">
              You can still replace or clear them below — neither reads the stored value.
            </p>
            <SmtpForm
              initial={null}
              passwordHint={null}
              onSaved={() => utils.admin.smtp.invalidate()}
            />
          </>
        ) : (
          <>
            {status.data.source === "undecryptable" ? (
              <p className="text-sm text-danger">
                Settings are stored but cannot be decrypted —{" "}
                <code className="text-xs">MASTER_KEY</code> does not match the one they were saved
                with. The password is unrecoverable; enter everything again, or clear it.
              </p>
            ) : status.data.source === "app_config" && status.data.updatedByName ? (
              <p className="text-xs text-default-500">
                Saved by {status.data.updatedByName}
                {status.data.updatedAt
                  ? ` on ${new Date(status.data.updatedAt).toLocaleDateString()}`
                  : null}
                .
              </p>
            ) : null}

            <SmtpForm
              initial={
                status.data.source === "app_config"
                  ? {
                      host: status.data.host ?? "",
                      port: status.data.port ?? 587,
                      secure: status.data.secure ?? false,
                      user: status.data.user ?? "",
                      fromAddress: status.data.fromAddress ?? "",
                      fromName: status.data.fromName ?? "",
                    }
                  : null
              }
              passwordHint={status.data.passwordHint}
              onSaved={() => utils.admin.smtp.invalidate()}
            />
          </>
        )}
      </CardBody>
    </Card>
  );
}

function SourceChip({ source }: { source: "app_config" | "none" | "undecryptable" }) {
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
      Configured
    </Chip>
  );
}

type SmtpFields = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  fromAddress: string;
  fromName: string;
};

const EMPTY: SmtpFields = {
  host: "",
  // 587 + STARTTLS is what every modern relay documents first.
  port: 587,
  secure: false,
  user: "",
  fromAddress: "",
  fromName: "Ledgerly",
};

function SmtpForm({
  initial,
  passwordHint,
  onSaved,
}: {
  initial: SmtpFields | null;
  /** The stored password's LENGTH, used as the placeholder. The box is
   *  write-only and always starts empty, which on its own reads as "no
   *  password set" — exactly the wrong impression when one IS set. A length is
   *  enough to answer that, and unlike the API key's last-four hint it
   *  discloses nothing about a secret that is often only 12-20 characters
   *  long (see `packages/api/src/smtp.ts`). */
  passwordHint: string | null;
  onSaved: () => Promise<unknown> | void;
}) {
  const utils = trpc.useUtils();
  const [fields, setFields] = useState<SmtpFields>(initial ?? EMPTY);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const set = <K extends keyof SmtpFields>(key: K, value: SmtpFields[K]): void => {
    setFields((current) => ({ ...current, [key]: value }));
    setSaved(false);
    setError(null);
    // A result from before the settings changed is worse than no result.
    setTestResult(null);
  };

  const save = trpc.admin.setSmtp.useMutation({
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      setPassword("");
      setTestResult(null);
      await onSaved();
    },
    onError: (e) => {
      setSaved(false);
      setError(e.message);
    },
  });

  const test = trpc.admin.testSmtp.useMutation({
    onSuccess: (result) => setTestResult(result),
    onError: (e) => setTestResult({ ok: false, message: e.message }),
  });

  const clear = trpc.admin.clearSmtp.useMutation({
    onSuccess: async () => {
      setFields(EMPTY);
      setPassword("");
      setError(null);
      setSaved(false);
      setTestResult(null);
      await utils.admin.smtp.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  const busy = save.isPending || test.isPending || clear.isPending;
  const canSave = fields.host.trim().length > 0 && fields.fromAddress.trim().length > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          size="sm"
          label="Host"
          placeholder="mail.smtp2go.com"
          className="flex-1"
          value={fields.host}
          onValueChange={(v) => set("host", v)}
          isDisabled={busy}
        />
        <Input
          size="sm"
          label="Port"
          inputMode="numeric"
          className="sm:max-w-[7rem]"
          value={String(fields.port)}
          onValueChange={(v) => set("port", Number(v.replace(/\D/g, "")) || 0)}
          isDisabled={busy}
        />
      </div>

      <Switch
        size="sm"
        isSelected={fields.secure}
        onValueChange={(v) => set("secure", v)}
        isDisabled={busy}
      >
        <span className="text-sm">
          Implicit TLS (port 465)
          <span className="block text-xs text-default-500">
            Leave off for 587 or 25 — those still encrypt, via STARTTLS, after connecting.
          </span>
        </span>
      </Switch>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          size="sm"
          label="Username"
          autoComplete="off"
          className="flex-1"
          value={fields.user}
          onValueChange={(v) => set("user", v)}
          isDisabled={busy}
        />
        <Input
          size="sm"
          type="password"
          label="Password"
          autoComplete="off"
          className="flex-1"
          placeholder={passwordHint ? `Set — ${passwordHint}` : ""}
          value={password}
          onValueChange={(v) => {
            setPassword(v);
            setSaved(false);
            setTestResult(null);
          }}
          isDisabled={busy}
        />
      </div>
      {passwordHint ? (
        <p className="text-xs text-default-500">
          Leave the password blank to keep the one already stored.
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          size="sm"
          label="From address"
          placeholder="receipts@example.com"
          type="email"
          className="flex-1"
          value={fields.fromAddress}
          onValueChange={(v) => set("fromAddress", v)}
          isDisabled={busy}
        />
        <Input
          size="sm"
          label="From name"
          className="flex-1"
          value={fields.fromName}
          onValueChange={(v) => set("fromName", v)}
          isDisabled={busy}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          color="primary"
          isDisabled={!canSave || busy}
          isLoading={save.isPending}
          onPress={() =>
            save.mutate({
              host: fields.host.trim(),
              port: fields.port,
              secure: fields.secure,
              user: fields.user.trim(),
              // Omitted, not empty-string: absent means "keep the stored one".
              ...(password.length > 0 ? { password } : {}),
              fromAddress: fields.fromAddress.trim(),
              fromName: fields.fromName.trim(),
            })
          }
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="flat"
          // Tests the STORED settings, not the draft — so save first. Said
          // plainly below rather than left for the operator to discover by
          // testing an unsaved change and believing the result.
          isDisabled={busy}
          isLoading={test.isPending}
          onPress={() => test.mutate()}
        >
          Send test email
        </Button>
        <Button
          size="sm"
          variant="flat"
          isDisabled={busy}
          isLoading={clear.isPending}
          onPress={() => clear.mutate()}
        >
          Clear
        </Button>
      </div>

      <p className="text-xs text-default-500">
        The test sends a real message to your own address, using the SAVED settings — save any
        changes first. Only an actual send distinguishes a wrong password from a blocked port from a
        From address the relay refuses.
      </p>

      {testResult ? (
        <p className={`text-sm ${testResult.ok ? "text-success" : "text-danger"}`}>
          {testResult.message}
        </p>
      ) : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {saved ? <p className="text-sm text-success">Saved.</p> : null}
    </div>
  );
}
