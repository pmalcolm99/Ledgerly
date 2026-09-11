import "server-only";

import { UnrecoverableError, Worker, type Job } from "bullmq";
import nodemailer from "nodemailer";
import { getEnv } from "@ledgerly/config/env";
import { getDb } from "@ledgerly/db/client";
import { resolveSmtpConfig, type SmtpConfig } from "@ledgerly/api/smtp";
import { recordEvent } from "@ledgerly/api/events";

import { getRedisConnection } from "./redis";
import { RECEIPT_EMAIL_QUEUE_NAME } from "./queue";
import { EmailError, processReceiptEmail } from "./pipeline/email";
import type { EmailJobData, EmailTransport } from "./pipeline/email";

/**
 * packages/queue/src/emailWorker.ts — the `receipt-email` worker (D-44).
 *
 * Mirrors `worker.ts`, including the parts that were learned the hard way:
 * the config is resolved PER JOB (an operator who fixes their SMTP password
 * must not have to restart the container to see it take effect), the built
 * transport is cached on the resolved config so a connection pool is not
 * discarded per message, and a non-retryable failure is thrown as
 * `UnrecoverableError` so BullMQ stops rather than burning four more attempts
 * on a condition no backoff can fix.
 *
 * **This is the only file that imports `nodemailer`, and it lives in
 * `packages/queue`** — the same containment `@anthropic-ai/sdk` gets, for the
 * same reason: the credential-consuming client must not be reachable from
 * anything `apps/web` could ship to a browser. `pipeline/email.ts` takes the
 * transport as a structurally-typed dependency and never names the library.
 *
 * Unlike an extraction failure, an email failure writes NOTHING to the
 * receipt. The receipt is the record; this is a notification about it, and a
 * relay outage must not leave a mark on financial data.
 */

let sharedEmailWorker: Worker<EmailJobData> | undefined;

/** Same one-entry cache as `worker.ts`'s Anthropic client, keyed on the whole
 *  serialised config so a changed port or password drops the old transport
 *  rather than accumulating one per config ever seen. */
function transportCacheKey(config: SmtpConfig): string {
  return JSON.stringify(config);
}

export async function startEmailWorker(redisUrl: string): Promise<Worker<EmailJobData>> {
  if (sharedEmailWorker) return sharedEmailWorker;

  const env = getEnv();
  const db = getDb();

  let cached: { key: string; transport: EmailTransport } | undefined;

  async function transportForJob(): Promise<{
    transport: EmailTransport | null;
    from: { address: string; name: string };
  }> {
    const { config, source } = await resolveSmtpConfig(db, env.MASTER_KEY);
    if (source === "undecryptable") {
      // Its own reason code, distinct from "not configured": the fix is
      // "restore the right MASTER_KEY, or clear the row and re-enter it",
      // which is nothing like "go and set up SMTP".
      throw new EmailError("SMTP_UNDECRYPTABLE", { retryable: false });
    }
    if (!config) return { transport: null, from: { address: "", name: "" } };

    const key = transportCacheKey(config);
    if (cached?.key !== key) {
      cached = {
        key,
        transport: nodemailer.createTransport({
          host: config.host,
          port: config.port,
          secure: config.secure,
          // A relay that takes no credentials (an internal MTA on the same
          // network) is a legitimate configuration; passing an empty `auth`
          // object makes nodemailer attempt AUTH and fail against one.
          ...(config.user ? { auth: { user: config.user, pass: config.password } } : {}),
        }),
      };
      console.log(`[ledgerly] SMTP transport initialised for ${config.host}:${config.port}`);
    }
    return {
      transport: cached.transport,
      from: { address: config.fromAddress, name: config.fromName },
    };
  }

  const worker = new Worker<EmailJobData>(
    RECEIPT_EMAIL_QUEUE_NAME,
    async (job: Job<EmailJobData>) => {
      try {
        const { transport, from } = await transportForJob();
        const outcome = await processReceiptEmail(
          {
            db,
            transport,
            from,
            uploadsDir: env.UPLOADS_DIR,
            maxMegapixels: env.MAX_UPLOAD_MEGAPIXELS,
            appOrigin: appOrigin(env.APP_HOSTNAME),
          },
          job.data,
        );
        // Logged either way. A skip is a normal outcome, but "why did no email
        // arrive" is the question this feature will actually generate, and the
        // answer should be one grep away.
        if (outcome.sent) {
          console.log(`[ledgerly] receipt email sent receipt=${job.data.receiptId}`);
          await recordEvent(db, {
            level: "info",
            category: "email",
            event: "email.sent",
            entityType: "receipt",
            entityId: job.data.receiptId,
            // The recipient as an ID, not an address (events.ts's policy); the
            // relay's own message id is the handle that ties this row to a row
            // in smtp2go's dashboard.
            metadata: {
              reason: job.data.reason,
              toUserId: outcome.toUserId,
              messageId: outcome.messageId,
            },
          });
        } else {
          console.log(
            `[ledgerly] receipt email skipped receipt=${job.data.receiptId} ` +
              `reason=${outcome.skipped}`,
          );
          // A skip is not an error, but it IS the answer to "why did no email
          // arrive" — which is the question this feature actually generates,
          // and which previously could only be answered from container logs.
          await recordEvent(db, {
            level: "warn",
            category: "email",
            event: "email.skipped",
            entityType: "receipt",
            entityId: job.data.receiptId,
            metadata: { reason: outcome.skipped, trigger: job.data.reason },
          });
        }
      } catch (error) {
        if (error instanceof EmailError && !error.retryable) {
          throw new UnrecoverableError(error.reason);
        }
        throw error;
      }
    },
    {
      connection: getRedisConnection(redisUrl),
      // Low on purpose. Relays rate-limit, and nothing here is latency
      // sensitive — the receipt is already saved and visible in the app.
      concurrency: 2,
      autorun: true,
    },
  );

  worker.on("failed", (job, error) => {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    const isUnrecoverable = error?.name === "UnrecoverableError";
    if (!isUnrecoverable && job.attemptsMade < attempts) return;
    const reason =
      error instanceof EmailError ? error.reason : (error?.message ?? "EMAIL_SEND_FAILED");
    // The RECEIPT is still untouched by a notification failure — see the
    // header, and that reasoning has not changed. What has changed is that the
    // log is no longer the whole record of it: the event goes to `app_events`,
    // which is about the system rather than about the receipt.
    console.error(
      `[ledgerly] receipt email gave up receipt=${job.data.receiptId} reason=${reason}`,
    );
    void recordEvent(db, {
      level: "error",
      category: "email",
      event: "email.gave_up",
      entityType: "receipt",
      entityId: job.data.receiptId,
      metadata: { reason, trigger: job.data.reason, attempts: job.attemptsMade },
    });
  });

  sharedEmailWorker = worker;
  return worker;
}

/**
 * One message, sent now, with an explicitly supplied config (D-44).
 *
 * The ONLY synchronous send in the application, and it exists for one screen:
 * `admin.testSmtp`, whose whole value is that it fails immediately and says
 * why. Everything else goes through the `receipt-email` queue, because a relay
 * must not be able to hold a user request open.
 *
 * Takes the config as an argument rather than resolving it, so the admin
 * screen tests the settings it is looking at. It builds a throwaway transport
 * for the same reason — a test must not be answered by a cached connection
 * from before the settings changed — and closes it, since nothing will reuse
 * it.
 *
 * Errors are thrown, not swallowed: the relay's own message ("535
 * authentication failed", "connect ETIMEDOUT") is the diagnosis the caller
 * shows the operator.
 */
export async function sendOneEmail(params: {
  config: SmtpConfig;
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const { config } = params;
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user ? { auth: { user: config.user, pass: config.password } } : {}),
  });
  try {
    await transport.sendMail({
      from: config.fromName
        ? `"${config.fromName.replace(/["\\]/g, "")}" <${config.fromAddress}>`
        : config.fromAddress,
      to: params.to,
      subject: params.subject,
      text: params.text,
    });
  } finally {
    transport.close();
  }
}

/**
 * `receipts.example.com` -> `https://receipts.example.com`.
 *
 * The email's one actionable element is a link back into the app, and
 * `APP_HOSTNAME` is a bare hostname by convention (D-16). A value that already
 * carries a scheme is passed through rather than double-prefixed, and an empty
 * one yields null so the body simply omits the link instead of rendering
 * `https:///receipts/...`.
 */
export function appOrigin(hostname: string | undefined): string | null {
  const host = hostname?.trim();
  if (!host) return null;
  if (host.startsWith("http://") || host.startsWith("https://")) return host.replace(/\/+$/, "");
  return `https://${host.replace(/\/+$/, "")}`;
}
