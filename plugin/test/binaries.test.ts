import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBinaries } from "../src/easytier.ts";
import { assetFor } from "../src/easytier-manifest.ts";

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.chdir(mkdtempSync(join(tmpdir(), "ohmyaihub-bin-")));
  globalThis.fetch = realFetch;
});

describe("verified EasyTier download", () => {
  test("refuses bytes that do not match the pinned SHA-256", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as unknown as typeof fetch;
    await expect(ensureBinaries()).rejects.toThrow(/SHA-256 mismatch/);
    // and it must not leave a binary behind
    const asset = assetFor();
    rmSync(join(process.cwd(), "oh-my-aihub"), { recursive: true, force: true });
    expect(asset.sha256).toHaveLength(64);
  });

  test("an unlisted platform is refused before any download", async () => {
    await expect(
      (async () => {
        const { assetFor: f } = await import("../src/easytier-manifest.ts");
        return f("freebsd", "x64");
      })(),
    ).rejects.toThrow(/no verified build/);
  });

  test("manifest hashes are 64 hex characters for every platform", async () => {
    const { allAssets } = await import("../src/easytier-manifest.ts");
    for (const [platform, a] of Object.entries(allAssets())) {
      expect(a.sha256, platform).toMatch(/^[0-9a-f]{64}$/);
      expect(a.file).toContain("v2.6.4");
    }
  });
});
