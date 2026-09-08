// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// The D-07 dependency direction: packages/shared is imported by Client
// Components, so it must never pull in a Node-only or server-only module.
// See ARCHITECTURE.md §2.1.
const SHARED_FORBIDDEN_IMPORTS = [
  {
    group: ["node:*"],
    message:
      "packages/shared must not import Node.js built-ins — it is imported by Client Components (ARCHITECTURE.md §2.1).",
  },
  {
    group: ["pg", "pg/*"],
    message: "packages/shared must not import the Postgres driver (ARCHITECTURE.md §2.1).",
  },
  {
    group: ["drizzle-orm/pg*", "drizzle-orm/node-postgres*"],
    message: "packages/shared must not import Drizzle's Postgres bindings (ARCHITECTURE.md §2.1).",
  },
  {
    group: ["bullmq", "bullmq/*"],
    message: "packages/shared must not import BullMQ (ARCHITECTURE.md §2.1).",
  },
  {
    group: ["ioredis", "ioredis/*"],
    message: "packages/shared must not import ioredis (ARCHITECTURE.md §2.1).",
  },
  {
    group: ["sharp", "sharp/*"],
    message: "packages/shared must not import sharp (ARCHITECTURE.md §2.1).",
  },
  {
    group: ["@anthropic-ai/sdk", "@anthropic-ai/sdk/*"],
    message: "packages/shared must not import the Anthropic SDK (ARCHITECTURE.md §2.1).",
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/public/**",
      "packages/db/migrations/**",
      // Next.js-generated; regenerated on every build/dev run, never
      // hand-edited (it says so at the top of the file).
      "apps/web/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // The D-07 rule, scoped to packages/shared's shipped source only. Test
  // files are exempt: they run under Vitest/Node, never ship to a client
  // bundle, and packages/shared/src/eslintRestrictedImports.test.ts
  // legitimately needs node:fs/path/url to prove this very rule fires.
  {
    files: ["packages/shared/**/*.{ts,tsx}"],
    ignores: ["packages/shared/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: SHARED_FORBIDDEN_IMPORTS }],
    },
  },
  // Config package: server-only env.ts may import node:*; edge.ts may not
  // (Edge Runtime has no process.env object, only inlined literals — see
  // packages/config/src/edge.ts).
  {
    files: ["packages/config/src/edge.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*"],
              message: "edge.ts runs on the Edge Runtime and must not import Node.js built-ins.",
            },
          ],
        },
      ],
    },
  },
);
