ALTER TABLE "projects" ADD COLUMN "email_receipts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "receipt_email_sent_at" timestamp with time zone;