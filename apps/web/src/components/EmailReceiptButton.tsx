"use client";

import { useState } from "react";
import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from "@heroui/react";
import { Send } from "lucide-react";

import { trpc } from "../lib/trpc";

/**
 * apps/web/src/components/EmailReceiptButton.tsx — send this receipt to
 * someone, now (D-44).
 *
 * ## The recipient list IS the input
 *
 * There is no address field. The menu is `members.list` for this project, and
 * what the mutation receives is a user id — which the server re-checks against
 * membership, twice (the procedure, then the worker). Mailing a receipt to an
 * arbitrary address is therefore not a validation failure, it is an operation
 * the API has no way to express.
 *
 * That is a deliberate constraint on convenience. "Email this to my
 * accountant" requires adding the accountant to the project first, which is
 * the same decision as letting them see the receipts anyway — made once,
 * visibly, in the members list, rather than implicitly in a text box.
 *
 * ## It reports queued, not delivered
 *
 * The mutation enqueues; a worker renders the attachment and talks to the
 * relay. So the confirmation says "queued", because claiming "sent" would be
 * a promise this component is in no position to make.
 *
 * "Queued" is nonetheless a real claim, which is why the procedure checks that
 * SMTP is configured BEFORE it enqueues. Without that check this button would
 * report success on an instance with no relay and the message would die in a
 * worker log — and a non-owner cannot read `admin.smtp` to find out why.
 */
export function EmailReceiptButton({
  receiptId,
  projectId,
}: {
  receiptId: string;
  projectId: string;
}) {
  const members = trpc.members.list.useQuery({ projectId });
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const send = trpc.receipts.emailReceipt.useMutation({
    onSuccess: () =>
      setResult({ ok: true, message: "Queued. It will arrive in a moment, with the image." }),
    onError: (e) => setResult({ ok: false, message: e.message }),
  });

  const recipients = members.data ?? [];

  return (
    <div className="flex flex-col gap-1">
      <Dropdown>
        <DropdownTrigger>
          <Button
            size="sm"
            variant="flat"
            startContent={<Send className="h-4 w-4" />}
            isLoading={send.isPending}
            // Nobody to send to means the list has not loaded, or the caller
            // cannot see it. Either way there is nothing to open.
            isDisabled={recipients.length === 0}
          >
            Email
          </Button>
        </DropdownTrigger>
        <DropdownMenu
          aria-label="Email this receipt to"
          onAction={(key) => {
            setResult(null);
            send.mutate({ id: receiptId, toUserId: String(key) });
          }}
        >
          {recipients.map((member) => (
            <DropdownItem key={member.userId} description={member.email}>
              {member.name}
            </DropdownItem>
          ))}
        </DropdownMenu>
      </Dropdown>

      {result ? (
        <p className={`text-xs ${result.ok ? "text-success" : "text-danger"}`}>{result.message}</p>
      ) : null}
    </div>
  );
}
