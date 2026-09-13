ALTER TABLE "receipts" ADD COLUMN "transaction_discount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "tax_included" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "date_unconfirmed" boolean DEFAULT false NOT NULL;