import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Magpie } from "../src/magpie.ts";

function stubBinary(dir: string, version = "magpie 0.1.2038"): { path: string; marker: string } {
  const marker = join(dir, "called");
  const path = join(dir, "magpie");
  writeFileSync(path, `#!/bin/sh\necho called >> ${JSON.stringify(marker)}\necho "${version}"\n`);
  chmodSync(path, 0o755);
  return { path, marker };
}

describe("Magpie instance", () => {
  test("version() is a method, not a shadowing field (PR #4 P0)", () => {
    const m = new Magpie("/does/not/exist/magpie");
    // The field used to be called `version` too: the instance field shadowed the
    // prototype method and `m.version()` threw "not a function".
    expect(typeof (m as unknown as { version: unknown }).version).toBe("function");
    expect(typeof m.version()).toBe("string");
    expect(m.version().startsWith("magpie")).toBe(true);
  });

  test("version() is stable and never starts a process", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmyaihub-ver-"));
    const { path, marker } = stubBinary(dir);
    const m = new Magpie(path);
    const first = m.version();
    expect(m.version()).toBe(first);
    expect(existsSync(marker)).toBe(false); // the label never costs a process
  });

  test("detectVersion() falls back to one --version call and caches it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmyaihub-ver2-"));
    const { path, marker } = stubBinary(dir, "magpie 0.1.2038");
    const m = new Magpie(path);
    const v = await m.detectVersion();
    expect(v).toContain("0.1.2038");
    expect(existsSync(marker)).toBe(true);
    await m.detectVersion();
    const calls = (await Bun.file(marker).text()).trim().split("\n").length;
    expect(calls).toBe(1); // cached, second call does not spawn
  });

  test("detectVersion() keeps a label when the binary does not answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmyaihub-ver3-"));
    const path = join(dir, "magpie");
    writeFileSync(path, "#!/bin/sh\nexit 1\n");
    chmodSync(path, 0o755);
    const m = new Magpie(path);
    expect(await m.detectVersion()).toContain("magpie");
  });
});
