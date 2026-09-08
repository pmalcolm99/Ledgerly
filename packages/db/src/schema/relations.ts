import { relations } from "drizzle-orm";

import { appConfig, instanceState } from "./instance";
import { categories } from "./categories";
import { aiUsage, auditLog } from "./ops";
import { projectMembers, projects } from "./projects";
import { receiptItems, receipts } from "./receipts";
import { users } from "./users";

// docs/SCHEMA.md §Entity relationships. All relations() declarations live
// here, not beside their tables — this is what avoids circular imports
// between schema files (a table only ever imports the tables its own
// foreign keys point at; the reverse direction is expressed only here).

export const usersRelations = relations(users, ({ many }) => ({
  ownedProjects: many(projects),
  projectMemberships: many(projectMembers),
  uploadedReceipts: many(receipts),
  createdCategories: many(categories),
  auditLogEntries: many(auditLog),
}));

export const instanceStateRelations = relations(instanceState, ({ one }) => ({
  owner: one(users, {
    fields: [instanceState.ownerId],
    references: [users.id],
  }),
}));

export const appConfigRelations = relations(appConfig, ({ one }) => ({
  updatedByUser: one(users, {
    fields: [appConfig.updatedBy],
    references: [users.id],
  }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  owner: one(users, {
    fields: [projects.ownerId],
    references: [users.id],
  }),
  members: many(projectMembers),
  receipts: many(receipts),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, {
    fields: [projectMembers.projectId],
    references: [projects.id],
  }),
  user: one(users, {
    fields: [projectMembers.userId],
    references: [users.id],
  }),
  grantedByUser: one(users, {
    fields: [projectMembers.grantedBy],
    references: [users.id],
  }),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  createdByUser: one(users, {
    fields: [categories.createdBy],
    references: [users.id],
  }),
  items: many(receiptItems),
}));

export const receiptsRelations = relations(receipts, ({ one, many }) => ({
  project: one(projects, {
    fields: [receipts.projectId],
    references: [projects.id],
  }),
  uploadedByUser: one(users, {
    fields: [receipts.uploadedBy],
    references: [users.id],
  }),
  items: many(receiptItems),
  usage: many(aiUsage),
}));

export const receiptItemsRelations = relations(receiptItems, ({ one }) => ({
  receipt: one(receipts, {
    fields: [receiptItems.receiptId],
    references: [receipts.id],
  }),
  category: one(categories, {
    fields: [receiptItems.categoryId],
    references: [categories.id],
  }),
}));

export const aiUsageRelations = relations(aiUsage, ({ one }) => ({
  receipt: one(receipts, {
    fields: [aiUsage.receiptId],
    references: [receipts.id],
  }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  actorUser: one(users, {
    fields: [auditLog.actorUserId],
    references: [users.id],
  }),
}));

// backups (packages/db/src/schema/ops.ts) has no foreign keys
// (docs/SCHEMA.md §backups), so it has no relations() to declare here.
