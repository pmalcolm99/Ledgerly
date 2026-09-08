// packages/shared — imported by both Client Components and server code.
// See ARCHITECTURE.md §2.1: this package must never import a Node.js
// built-in or a server-only dependency (pg, drizzle-orm/pg, bullmq,
// ioredis, sharp, @anthropic-ai/sdk). Enforced by eslint.config.js's
// no-restricted-imports rule, proven in eslintRestrictedImports.test.ts.

export const LEDGERLY_SHARED_VERSION = "0.1.0";
