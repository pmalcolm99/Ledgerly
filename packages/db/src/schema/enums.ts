import { pgEnum } from "drizzle-orm/pg-core";

// docs/SCHEMA.md §Enums.
//
// `memberPermissionEnum` is ordered read < read_add < full, and the order is
// load-bearing: `scopedProjects(user, level)` (Phase 4) compares against it
// directly. Postgres enums compare by declaration order — new levels are
// appended, never inserted.

export const userRoleEnum = pgEnum("user_role", ["owner", "user"]);
export const projectStatusEnum = pgEnum("project_status", ["active", "archived"]);
export const memberPermissionEnum = pgEnum("member_permission", ["read", "read_add", "full"]);
export const extractionStatusEnum = pgEnum("extraction_status", [
  "pending",
  "ok",
  "partial",
  "failed",
]);
export const backupKindEnum = pgEnum("backup_kind", ["manual", "scheduled"]);
export const backupStatusEnum = pgEnum("backup_status", ["running", "complete", "failed"]);
