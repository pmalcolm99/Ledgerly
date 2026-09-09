/**
 * The client's half of the onboarding contract.
 *
 * `protectedProcedure` (packages/api/src/trpc.ts) throws FORBIDDEN with the
 * literal message `ONBOARDING_REQUIRED`, and its comment names redirecting to
 * /welcome as the client's responsibility. Nothing implemented that until now,
 * so a half-onboarded session would have shown a wall of red error states
 * instead of the form that fixes it.
 *
 * Matched on the message rather than the code because FORBIDDEN is also the
 * correct answer to several genuine permission failures, which must NOT
 * redirect.
 */
export const ONBOARDING_REQUIRED = "ONBOARDING_REQUIRED";

export function isOnboardingRequiredError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    (error as { message?: unknown }).message === ONBOARDING_REQUIRED
  );
}
