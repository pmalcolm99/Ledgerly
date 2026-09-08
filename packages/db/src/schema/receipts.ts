import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { categories } from "./categories";
import { extractionStatusEnum } from "./enums";
import { projects } from "./projects";
import { users } from "./users";

// docs/SCHEMA.md §receipts. Every extracted field is nullable — extraction
// never fails an upload (CLAUDE.md hard rule).
export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),

    merchantName: text("merchant_name"),
    merchantAddress: text("merchant_address"),
    merchantPhone: text("merchant_phone"),

    transactionDate: date("transaction_date"),
    transactionTime: time("transaction_time"),

    subtotal: numeric("subtotal", { precision: 12, scale: 2 }),
    salesTax: numeric("sales_tax", { precision: 12, scale: 2 }),
    tip: numeric("tip", { precision: 12, scale: 2 }),
    total: numeric("total", { precision: 12, scale: 2 }),
    currency: char("currency", { length: 3 }).notNull().default("USD"),

    cardLast4: char("card_last4", { length: 4 }),
    paymentMethod: text("payment_method"),

    imageKey: text("image_key"),
    thumbKey: text("thumb_key"),
    originalKey: text("original_key"),

    extractionStatus: extractionStatusEnum("extraction_status").notNull().default("pending"),
    extractionModel: text("extraction_model"),
    extractionPass: smallint("extraction_pass"),
    extractionConfidence: numeric("extraction_confidence", { precision: 4, scale: 3 }),
    extractionRaw: jsonb("extraction_raw"),
    extractionError: text("extraction_error"),
    missingFields: text("missing_fields")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    userNotes: text("user_notes"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "receipts_card_last4_digits",
      sql`${t.cardLast4} IS NULL OR ${t.cardLast4} ~ '^[0-9]{4}$'`,
    ),
    check(
      "receipts_confidence_range",
      sql`${t.extractionConfidence} IS NULL OR (${t.extractionConfidence} >= 0 AND ${t.extractionConfidence} <= 1)`,
    ),
    check(
      "receipts_date_sane",
      sql`${t.transactionDate} IS NULL OR ${t.transactionDate} >= DATE '2000-01-01'`,
    ),
    // dashboard list — NOTE (D-22 adjacent): verify `DESC NULLS LAST` and the
    // `WHERE deleted_at IS NULL` partial clause both land in the generated
    // migration; hand-append if drizzle-kit drops either.
    index("receipts_project_date_idx")
      .on(t.projectId, t.transactionDate.desc().nullsLast())
      .where(sql`${t.deletedAt} IS NULL`),
    // review queue
    index("receipts_review_idx")
      .on(t.projectId, t.extractionStatus)
      .where(sql`${t.deletedAt} IS NULL AND ${t.extractionStatus} <> 'ok'`),
    // reconciliation sweep (D-08)
    index("receipts_pending_idx")
      .on(t.createdAt)
      .where(sql`${t.deletedAt} IS NULL AND ${t.extractionStatus} = 'pending'`),
  ],
);

// docs/SCHEMA.md §receipt_items.
export const receiptItems = pgTable(
  "receipt_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => receipts.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "restrict" }),
    lineNo: integer("line_no").notNull(),
    description: text("description").notNull(),
    sku: text("sku"),
    quantity: numeric("quantity", { precision: 12, scale: 3 }),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }),
    lineTotal: numeric("line_total", { precision: 12, scale: 2 }),
    aiAssignedCategory: boolean("ai_assigned_category").notNull().default(false),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("receipt_items_line_no_positive", sql`${t.lineNo} > 0`),
    check(
      "receipt_items_confidence_range",
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`,
    ),
    uniqueIndex("receipt_items_line_key").on(t.receiptId, t.lineNo),
    index("receipt_items_receipt_idx").on(t.receiptId),
    index("receipt_items_category_idx").on(t.categoryId),
  ],
);
