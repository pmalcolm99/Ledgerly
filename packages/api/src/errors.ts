/**
 * packages/api/src/errors.ts — small shared error-classification helpers.
 * Extracted from `routers/admin.ts`'s `relinkAccount`, the first place this
 * check was needed; `routers/projects.ts` and `routers/members.ts` reuse it
 * rather than each carrying their own copy of the same `error.code` probe.
 *
 * Both helpers take the expected constraint name, matching
 * `packages/auth/src/provision.ts`'s `isUniqueViolation` convention —
 * task 4.8 follow-up review finding: a constraint-agnostic check maps
 * *every* violation of that SQLSTATE to the same client-facing error, which
 * is correct only while each call site has exactly one plausible
 * constraint. Phase 5 adds more FKs to `project_members`'s neighborhood;
 * naming the constraint now means a future, unrelated violation surfaces
 * as an honest 500 instead of silently becoming a wrong 404/CONFLICT.
 */

function matches(error: unknown, code: string, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === code && candidate.constraint === constraint;
}

/**
 * True if `error` is a Postgres unique-violation (SQLSTATE 23505) on the
 * named constraint or index. Callers catch this around a write and
 * re-throw as `TRPCError({code:"CONFLICT"})` with a clean message, rather
 * than letting the raw constraint name reach the client (task 3.12 finding
 * H-1).
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return matches(error, "23505", constraint);
}

/**
 * True if `error` is a Postgres foreign-key-violation (SQLSTATE 23503) on
 * the named constraint — e.g. inserting a `project_members` row for a
 * `userId` that doesn't exist. Callers catch this and re-throw as
 * `TRPCError({code:"NOT_FOUND"})` rather than a raw 500 (task 4.8 review
 * finding M-3).
 */
export function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  return matches(error, "23503", constraint);
}
