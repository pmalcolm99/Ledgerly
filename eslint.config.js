// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";

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
    // Phase 8. `exceljs` is CJS, pulls archiver/unzipper, and is server-only
    // — the same class of dependency as the four above, added to the list at
    // the same time it entered the repo rather than after someone imported
    // it from a Client Component.
    group: ["exceljs", "exceljs/*"],
    message: "packages/shared must not import exceljs (ARCHITECTURE.md §2.1).",
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
  // React rules, scoped to apps/web — the only package with components.
  //
  // `react-hooks/exhaustive-deps` is the reason this is here rather than
  // left to code review: FORKD_LESSONS.md records a production bug where a
  // debounced handler captured `searchParams` at mount and, 300ms later,
  // rebuilt the URL from that stale copy and wiped a live filter. That is a
  // stale-closure bug, it was timing-dependent, and it is exactly what this
  // rule reports. Ledgerly's own Filters.tsx is written to avoid it; the rule
  // is what stops the next component from reintroducing it.
  //
  // `@next/next` also supplies the rules Next's own build expects to exist —
  // without the plugin, an `eslint-disable-next-line @next/next/no-img-element`
  // comment is itself a build error ("Definition for rule ... was not found").
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "@next/next": nextPlugin,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
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
