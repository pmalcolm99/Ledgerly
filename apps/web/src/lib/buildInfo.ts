/**
 * apps/web/src/lib/buildInfo.ts — which build is this?
 *
 * `APP_VERSION` and `APP_GIT_SHA` are inlined by `next.config.ts` at build
 * time, so these are literals in the emitted bundle rather than a runtime
 * lookup. That matters: `process.env` is not populated in the browser, and the
 * whole point is that a client component can render this without a round trip.
 *
 * Written as `process.env.APP_VERSION`, NOT destructured or accessed
 * dynamically — Next's inlining is a literal textual substitution of
 * `process.env.X`, and anything cleverer than that silently yields undefined.
 *
 * Mirrors Forkd: full semver, sha cut to seven characters, rendered
 * `v1.2.2 (a1b2c3d)`. A local `docker compose build` that passes no build arg
 * reports `dev`, which is the honest answer for an image built from a working
 * tree rather than a commit.
 */

export const APP_VERSION = process.env.APP_VERSION ?? "unknown";

/** The full sha, or "dev". Prefer `SHORT_SHA` for display. */
export const APP_GIT_SHA = process.env.APP_GIT_SHA ?? "dev";

export const SHORT_SHA = APP_GIT_SHA.slice(0, 7);

/** `v0.1.0 (a1b2c3d)` — the one string every surface should use, so the two
 *  places it appears cannot drift into different formats. */
export function buildLabel(): string {
  return `v${APP_VERSION} (${SHORT_SHA})`;
}
