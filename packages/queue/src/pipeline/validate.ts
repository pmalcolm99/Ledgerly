/**
 * Re-export. The implementation moved to `packages/shared/src/
 * receiptValidation.ts` in Phase 7 so `packages/api` can reach it too — see
 * that file's header for why. This shim exists so `extract.ts` and
 * `validate.test.ts` keep their original import path and remain the
 * regression net for the move.
 */
export { runSanityChecks } from "@ledgerly/shared/receiptValidation";
export type {
  ValidationFlag,
  ValidationInput,
  ValidationResult,
} from "@ledgerly/shared/receiptValidation";
