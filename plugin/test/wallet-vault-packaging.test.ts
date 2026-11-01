import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Magpie installs a GitHub plugin as the repository's root package. The root
 * package.json therefore has to declare `ethers`; the nested plugin/package.json
 * alone is not installed by `bun add github:owner/repo`.
 *
 * These checks are static so they cannot replace the actual installation
 * experiment in the review handoff, but they prevent the root dependency from
 * being dropped again.
 */
const root = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  main?: string;
  files?: string[];
  dependencies?: Record<string, string>;
};
const plugin = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  files?: string[];
  dependencies?: Record<string, string>;
};

describe("GitHub plugin packaging", () => {
  test("the repository root package pins the same ethers as the plugin workspace", () => {
    expect(root.dependencies?.ethers).toBe("6.17.0");
    expect(plugin.dependencies?.ethers).toBe("6.17.0");
  });

  test("the root package loads plugin/src and includes the vault sources", () => {
    expect(root.main).toBe("plugin/src/index.ts");
    expect(root.files).toContain("plugin/src/");
    expect(plugin.files).toContain("src/");
  });
});
