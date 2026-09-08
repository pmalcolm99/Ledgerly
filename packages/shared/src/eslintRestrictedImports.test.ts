// Proves the D-07 dependency-direction rule (task 2.2, eslint.config.js)
// actually fires, without leaving a permanently-failing fixture file in the
// tree that would break `pnpm lint`. The fixture text below is linted
// in-memory against the real root config, with a filename that places it
// inside packages/shared/src so the rule's `files` glob matches it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

async function lintFixture(source: string, filename: string): Promise<ESLint.LintResult> {
  const eslint = new ESLint({ cwd: repoRoot });
  const results = await eslint.lintText(source, {
    filePath: path.join(repoRoot, filename),
  });
  const result = results[0];
  if (!result) {
    throw new Error("eslint.lintText returned no results for the fixture source.");
  }
  return result;
}

describe("packages/shared may not import forbidden dependencies (D-07)", () => {
  it("fails lint on `import ... from 'node:crypto'`", async () => {
    const result = await lintFixture(
      "import { randomUUID } from 'node:crypto';\nexport const id = randomUUID();\n",
      "packages/shared/src/__fixture__.ts",
    );

    const restrictedImportErrors = result.messages.filter(
      (m) => m.ruleId === "no-restricted-imports",
    );
    expect(restrictedImportErrors.length).toBeGreaterThan(0);
    expect(restrictedImportErrors[0]?.message).toContain("packages/shared");
  });

  it.each(["pg", "drizzle-orm/pg-core", "bullmq", "ioredis", "sharp", "@anthropic-ai/sdk"])(
    "fails lint on `import ... from '%s'`",
    async (specifier) => {
      const result = await lintFixture(
        `import x from '${specifier}';\nexport default x;\n`,
        "packages/shared/src/__fixture__.ts",
      );
      const restrictedImportErrors = result.messages.filter(
        (m) => m.ruleId === "no-restricted-imports",
      );
      expect(restrictedImportErrors.length).toBeGreaterThan(0);
    },
  );

  it("does not flag an ordinary import", async () => {
    const result = await lintFixture(
      "import { z } from 'zod';\nexport const schema = z.string();\n",
      "packages/shared/src/__fixture__.ts",
    );
    const restrictedImportErrors = result.messages.filter(
      (m) => m.ruleId === "no-restricted-imports",
    );
    expect(restrictedImportErrors).toHaveLength(0);
  });
});

// Sanity: the config file this test exercises actually exists at the path
// we resolved repoRoot against, so a future directory shuffle fails loudly
// here instead of via a silently-passing "no rule matched" false negative.
describe("eslint.config.js exists at the resolved repo root", () => {
  it("can be read", () => {
    const contents = readFileSync(path.join(repoRoot, "eslint.config.js"), "utf-8");
    expect(contents).toContain("no-restricted-imports");
  });
});
