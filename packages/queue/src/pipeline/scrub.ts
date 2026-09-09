/**
 * Re-export. The implementation moved to `packages/shared/src/scrub.ts` in
 * Phase 7: `receipts.update` accepts free text straight from a user, and a
 * card number pasted into the notes field is the same hazard CLAUDE.md's
 * scrub rule exists for. `packages/api` cannot import `@ledgerly/queue`
 * (circular), so the pure function lives in `shared` and both call it.
 * This shim keeps `extract.ts` and `scrub.test.ts` unchanged.
 */
export { normalizeCardLast4, scrubLuhnSequences } from "@ledgerly/shared/scrub";
export type { ScrubResult } from "@ledgerly/shared/scrub";
