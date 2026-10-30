import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_KEYS,
  DIGEST_KEYS,
  SEED_KEYS,
  canonical,
  decideOptions,
  diffPatch,
  digestOf,
  maskPageText,
  normalizeOptions,
  ownedOptions,
  parseOptions,
  pageOptionsView,
  readAppliedRecord,
  seedPatch,
  writeAppliedRecord,
  withPreviousApplied,
  writePageOptions,
  type AppliedRecord,
} from "../src/plugin-options.ts";

const SECRET = "overlay-secret-1";
const seed = { networkName: "lab", networkSecret: SECRET, peers: ["tcp://relay:11010"], sharingEnabled: true };

function record(options: Parameters<typeof digestOf>[0], source: AppliedRecord["source"] = "seed", applied?: Record<string, unknown>): AppliedRecord {
  return {
    version: 1,
    phase: "done",
    at: "2026-10-30T00:00:00.000Z",
    digest: digestOf(options),
    source,
    applied: applied ?? { ...options },
  };
}

describe("parseOptions: what is not usable is refused, never rewritten", () => {
  test("coerces the shapes Magpie may hand over and keeps the known keys", () => {
    const { options: o, problems } = parseOptions({
      networkName: "  lab  ",
      networkSecret: SECRET,
      peers: "tcp://a:1, tcp://b:2",
      listenAddr: "127.0.0.1:11010",
      publishedPorts: ["3425", 3426],
      secureMode: true,
      sharingEnabled: true,
      rpcPort: "13400",
      catalogPort: 3426,
      pagePrefs: { showAdvanced: true, junk: 1 },
      unknownKey: { anything: true },
    });
    expect(problems).toEqual([]);
    expect(o.networkName).toBe("lab");
    expect(o.peers).toEqual(["tcp://a:1", "tcp://b:2"]);
    expect(o.listenAddr).toBe("127.0.0.1:11010");
    expect(o.publishedPorts).toEqual([3425, 3426]);
    expect(o.rpcPort).toBe(13400);
    expect(o.pagePrefs).toEqual({ showAdvanced: true });
    expect((o as Record<string, unknown>).catalogPort).toBe(3426);
    expect((o as Record<string, unknown>).unknownKey).toBeUndefined();
  });

  test("a bad value is refused and left out, not clamped into a different one", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ publishedPorts: ["3425", "nope", 0] }, /publishedPorts/],
      [{ publishedPorts: [70000] }, /publishedPorts/],
      [{ secureMode: "yes" }, /secureMode/],
      [{ networkName: "lab with spaces" }, /networkName/],
      [{ networkName: "a" }, /networkName/],
      [{ networkSecret: "short" }, /networkSecret/],
      [{ networkSecret: "x".repeat(700) }, /networkSecret/],
      [{ peers: ["ws://%%%"] }, /peers/],
      [{ rpcPort: 0 }, /rpcPort/],
      [{ catalogPort: 80 }, /catalogPort/],
      [{ role: "both" }, /role/],
    ];
    for (const [input, why] of cases) {
      const { options, problems } = parseOptions(input);
      expect(problems.some((p) => why.test(p))).toBe(true);
      for (const key of Object.keys(input)) {
        if (key === "publishedPorts" || key === "peers") expect(options[key as keyof typeof options]).toBeUndefined();
      }
    }
  });

  test("a secret is never truncated: too long is refused", () => {
    const long = "s".repeat(600);
    const { options, problems } = parseOptions({ networkName: "lab", networkSecret: long });
    expect(problems.join(" ")).toContain("networkSecret");
    expect(options.networkSecret).toBeUndefined();
  });

  test("every key the wizard may seed survives normalisation under its own name", () => {
    const sample = (k: string): unknown => {
      switch (k) {
        case "role":
          return "provider";
        case "networkName":
          return "lab";
        case "networkSecret":
          return SECRET;
        case "peers":
          return ["tcp://relay:11010"];
        case "publishedPorts":
          return [3425];
        case "shareModels":
          return ["native/approved"];
        case "rpcPort":
          return 15901;
        case "catalogPort":
          return 3496;
        case "catalogDiscovery":
          return true;
        default:
          return /Enabled|secureMode/.test(k) ? true : "127.0.0.1:11010";
      }
    };
    for (const k of SEED_KEYS) {
      const value = sample(k);
      const parsed = parseOptions({ [k]: value });
      expect(parsed.problems).toEqual([]);
      expect((parsed.options as Record<string, unknown>)[k]).toEqual(value);
    }
  });

  test("a value of the wrong type never becomes a config value", () => {
    const o = normalizeOptions({ networkName: 42, peers: { a: 1 }, publishedPorts: true, pagePrefs: "on" });
    expect(o.networkName).toBe("42");
    expect(o.peers).toBeUndefined();
    expect(o.publishedPorts).toBeUndefined();
    expect(o.pagePrefs).toBeUndefined();
  });
});

describe("digest", () => {
  test("is order independent and ignores what this plugin does not read", () => {
    const a = normalizeOptions({ networkName: "lab", peers: ["tcp://a:1"], rpcPort: 13400 });
    const b = normalizeOptions({ rpcPort: 13400, peers: ["tcp://a:1"], networkName: "lab", somethingElse: true });
    expect(digestOf(a)).toBe(digestOf(b));
    expect(digestOf(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes when any owned key changes", () => {
    expect(digestOf(normalizeOptions({ peers: ["tcp://a:1"] }))).not.toBe(digestOf(normalizeOptions({ peers: ["tcp://a:2"] })));
  });

  test("canonical() sorts objects and keeps arrays in order", () => {
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonical([2, 1])).toBe("[2,1]");
    expect(canonical({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe("decideOptions: seeding a new node", () => {
  test("seeds from a complete options blob", () => {
    const options = normalizeOptions(seed);
    const d = decideOptions({ options, configured: false, record: null });
    expect(d.kind).toBe("seed");
    if (d.kind !== "seed") throw new Error("unreachable");
    expect(d.patch.networkName).toBe("lab");
    expect(d.patch.networkSecret).toBe(SECRET);
    expect(d.record.source).toBe("seed");
    expect(d.record.digest).toBe(digestOf(options));
  });

  test("refuses to seed from half a configuration", () => {
    for (const options of [
      normalizeOptions({ networkName: "lab" }),
      normalizeOptions({ networkSecret: SECRET }),
      normalizeOptions({ networkName: "lab", networkSecret: "short" }),
    ]) {
      const d = decideOptions({ options, configured: false, record: null });
      expect(d.kind).toBe("none");
      expect(d.record).toBeUndefined();
    }
  });

  test("a failed seed cools down, then retries, and a new save retries immediately", () => {
    const options = normalizeOptions(seed);
    const failedAt = "2026-10-30T00:00:00.000Z";
    const failed: AppliedRecord = { ...record(options), at: failedAt, error: "configure failed: unknown certificate verification error" };

    // inside the cooldown: nobody hammers the network on every page open
    const cooling = decideOptions({ options, configured: false, record: failed, now: "2026-10-30T00:00:30.000Z" });
    expect(cooling.kind).toBe("none");
    if (cooling.kind === "none") expect(cooling.reason).toMatch(/retrying the same save in \d+s/);

    // after it, the same values are worth another attempt
    const retried = decideOptions({ options, configured: false, record: failed, now: "2026-10-30T00:05:00.000Z" });
    expect(retried.kind).toBe("seed");

    // a changed save never waits
    const fixed = decideOptions({
      options: normalizeOptions({ ...seed, networkSecret: "another-secret" }),
      configured: false,
      record: failed,
      now: "2026-10-30T00:00:30.000Z",
    });
    expect(fixed.kind).toBe("seed");
  });
});

describe("decideOptions: an already configured node", () => {
  test("first migration keeps the state that is serving", () => {
    const options = normalizeOptions({ ...seed, networkSecret: "stale-secret-9" });
    const d = decideOptions({ options, configured: true, record: null });
    expect(d.kind).toBe("none");
    if (d.kind === "none") expect(d.reason).toContain("existing state wins");
    expect(d.record?.source).toBe("migrated");
    // the record carries the options as seen, so the next real save is a diff
    expect(d.record?.applied.networkSecret).toBe("stale-secret-9");
  });

  test("an unchanged blob does nothing", () => {
    const options = normalizeOptions(seed);
    const d = decideOptions({ options, configured: true, record: record(options) });
    expect(d.kind).toBe("none");
    expect(d.record).toBeUndefined();
  });

  test("a new save is a patch of only the keys that changed", () => {
    const applied = normalizeOptions({ ...seed, peers: ["tcp://old:1"] });
    const next = normalizeOptions({ ...seed, peers: ["tcp://new:2"] });
    const d = decideOptions({ options: next, configured: true, record: record(applied) });
    expect(d.kind).toBe("patch");
    if (d.kind !== "patch") throw new Error("unreachable");
    expect(Object.keys(d.patch)).toEqual(["peers"]);
    expect(d.patch.peers).toEqual(["tcp://new:2"]);
  });

  test("a stale secret that nobody touched is never re-sent", () => {
    // The CLI rotated the secret; plugins.json still holds the old one. A save
    // that changes only the peers must not put the old secret back.
    const applied = normalizeOptions({ ...seed, peers: ["tcp://old:1"] });
    const next = normalizeOptions({ ...seed, peers: ["tcp://new:2"] });
    const d = decideOptions({ options: next, configured: true, record: record(applied) });
    if (d.kind !== "patch") throw new Error("expected a patch");
    expect(d.patch).not.toHaveProperty("networkSecret");
  });

  test("a deliberately edited secret is a patch, and only that", () => {
    const applied = normalizeOptions(seed);
    const next = normalizeOptions({ ...seed, networkSecret: "a-brand-new-secret" });
    const d = decideOptions({ options: next, configured: true, record: record(applied) });
    if (d.kind !== "patch") throw new Error("expected a patch");
    expect(Object.keys(d.patch)).toEqual(["networkSecret"]);
  });

  test("deleting a key from the options is not a change", () => {
    const applied = normalizeOptions({ ...seed, rpcPort: 13400 });
    const next = normalizeOptions({ ...seed });
    expect(diffPatch(ownedOptions(applied, CONFIG_KEYS), next)).toEqual({});
  });

  test("a preferences-only save on an unconfigured node does not re-seed", () => {
    // otherwise toggling a display preference would start the EasyTier download again
    const applied = normalizeOptions({ ...seed });
    const next = normalizeOptions({ ...seed, pagePrefs: { showAdvanced: true } });
    const d = decideOptions({ options: next, configured: false, record: record(applied) });
    expect(d.kind).toBe("none");
    if (d.kind === "none") expect(d.reason).toContain("preferences");
    expect(d.record?.digest).toBe(digestOf(next));
  });

  test("a preferences-only save does not restart a seed that just failed", () => {
    const applied = normalizeOptions(seed);
    const failed: AppliedRecord = { ...record(applied), at: "2026-10-30T00:00:00.000Z", error: "configure failed: no certificate" };
    const next = normalizeOptions({ ...seed, pagePrefs: { showAdvanced: true } });
    const d = decideOptions({ options: next, configured: false, record: failed, now: "2026-10-30T00:00:20.000Z" });
    expect(d.kind).toBe("none");
    if (d.kind === "none") {
      expect(d.reason).toContain("failed");
      expect(d.reason).toMatch(/retrying the same save in \d+s/);
    }
  });

  test("a preferences-only save updates the digest and touches no overlay key", () => {
    const applied = normalizeOptions(seed);
    const next = normalizeOptions({ ...seed, pagePrefs: { showAdvanced: true } });
    const d = decideOptions({ options: next, configured: true, record: record(applied) });
    expect(d.kind).toBe("none");
    if (d.kind === "none") expect(d.reason).toContain("preferences");
    expect(d.record?.digest).toBe(digestOf(next));
    expect(d.record?.applied).not.toHaveProperty("pagePrefs");
  });
});

describe("refused options and interrupted attempts", () => {
  test("a save with an unusable value configures nothing and says why", () => {
    const parsed = parseOptions({ networkName: "lab", networkSecret: SECRET, publishedPorts: [0] });
    const d = decideOptions({ options: parsed.options, configured: false, record: null, problems: parsed.problems });
    expect(d.kind).toBe("none");
    if (d.kind === "none") expect(d.reason).toContain("refused");
  });

  test("a pending record from a crash is retried, not taken as done", () => {
    // index.ts writes `pending` before Service.configure; a crash there leaves no
    // configuration behind, so the same options must be tried again.
    const options = normalizeOptions(seed);
    const pending: AppliedRecord = { ...record(options), phase: "pending" };
    const d = decideOptions({ options, configured: false, record: pending });
    expect(d.kind).toBe("seed");
  });

  test("a pending record that already failed is not retried inside the cooldown", () => {
    const options = normalizeOptions(seed);
    const pending: AppliedRecord = {
      ...record(options),
      phase: "pending",
      at: "2026-10-30T00:00:00.000Z",
      error: "configure failed: no certificate",
    };
    const d = decideOptions({ options, configured: false, record: pending, now: "2026-10-30T00:00:30.000Z" });
    expect(d.kind).toBe("none");
  });
});

describe("a crash between the pending write and Service.configure", () => {
  const oldOptions = { networkName: "old-net", networkSecret: SECRET, peers: ["tcp://old:11010"] };
  const newOptions = { ...oldOptions, peers: ["tcp://new:11010"] };

  /** what index.ts writes before configure, given the previous record */
  const pending = (candidate: typeof newOptions, previous: AppliedRecord | null, at: string) => ({
    ...withPreviousApplied({ ...record(normalizeOptions(candidate)), digest: digestOf(normalizeOptions(candidate)), at }, previous),
    phase: "pending" as const,
  });

  test("the same patch is retried after a restart, and only its changed fields", () => {
    const previous = record(normalizeOptions(oldOptions));
    // 1) the operator saves a new peer list; index.ts writes pending and dies
    const first = decideOptions({ options: normalizeOptions(newOptions), configured: true, record: previous });
    expect(first.kind).toBe("patch");
    if (first.kind !== "patch") throw new Error("unreachable");
    expect(Object.keys(first.patch)).toEqual(["peers"]);
    const crashed = pending(newOptions, previous, "2026-10-30T00:00:05.000Z");

    // 2) the next boot sees a pending record whose applied snapshot is the OLD
    //    configuration: the diff must still be the peers change
    const retry = decideOptions({
      options: normalizeOptions(newOptions),
      configured: true,
      record: crashed,
      now: "2026-10-30T00:01:00.000Z",
    });
    expect(retry.kind).toBe("patch");
    if (retry.kind !== "patch") throw new Error("unreachable");
    expect(Object.keys(retry.patch)).toEqual(["peers"]);
    expect(retry.patch.peers).toEqual(["tcp://new:11010"]);
    expect(retry.patch).not.toHaveProperty("networkSecret");
  });

  test("only a finished configure advances the applied snapshot", () => {
    const previous = record(normalizeOptions(oldOptions));
    const crashed = pending(newOptions, previous, "2026-10-30T00:00:05.000Z");
    // the pending record still carries the old configuration
    expect(crashed.applied.networkSecret).toBe(SECRET);
    expect(crashed.applied.peers).toEqual(["tcp://old:11010"]);
    // after a successful configure the record keeps the candidate, and the next
    // boot has nothing left to do
    const done: AppliedRecord = { ...crashed, phase: "done", applied: { ...normalizeOptions(newOptions) } };
    const after = decideOptions({ options: normalizeOptions(newOptions), configured: true, record: done });
    expect(after.kind).toBe("none");
  });

  test("a failed patch keeps the old snapshot, so the cooldown retry is the same patch", () => {
    const previous = record(normalizeOptions(oldOptions));
    const failed: AppliedRecord = {
      ...pending(newOptions, previous, "2026-10-30T00:00:05.000Z"),
      phase: "done",
      error: "configure failed: unknown certificate verification error",
    };
    // A failed patch left the previous configuration in force, so the next boot
    // applies the same patch again (the cooldown exists for a first-run seed,
    // which may block on an EasyTier download; a patch that fails changes nothing).
    const retried = decideOptions({
      options: normalizeOptions(newOptions),
      configured: true,
      record: failed,
      now: "2026-10-30T00:00:30.000Z",
    });
    expect(retried.kind).toBe("patch");
    if (retried.kind !== "patch") throw new Error("unreachable");
    expect(Object.keys(retried.patch)).toEqual(["peers"]);
  });

  test("the same crash on a first run still seeds", () => {
    const previous = null;
    const crashed = pending(newOptions, previous, "2026-10-30T00:00:05.000Z");
    const retry = decideOptions({ options: normalizeOptions(newOptions), configured: false, record: crashed });
    expect(retry.kind).toBe("seed");
    if (retry.kind !== "seed") throw new Error("unreachable");
    expect(retry.patch.networkName).toBe("old-net");
  });
});

describe("the applied record on disk", () => {
  test("round-trips and ignores a corrupt file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmyaihub-record-"));
    const file = join(dir, "applied-options.json");
    const options = normalizeOptions(seed);
    const rec = record(options);
    writeAppliedRecord(rec, file);
    const back = readAppliedRecord(file);
    expect(back?.digest).toBe(rec.digest);
    expect(back?.source).toBe("seed");
    expect(back?.applied.networkName).toBe("lab");

    writeFileSync(file, "{not json");
    expect(readAppliedRecord(file)).toBeNull();
    expect(readAppliedRecord(join(dir, "absent.json"))).toBeNull();
  });

  test("a record with an unknown version is ignored rather than trusted", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmyaihub-record-"));
    const file = join(dir, "applied-options.json");
    writeFileSync(file, JSON.stringify({ version: 99, digest: "x", at: "y" }));
    expect(readAppliedRecord(file)).toBeNull();
  });
});

describe("the page's view of the options", () => {
  test("a patch is reported as applied, a drift as drifted", () => {
    const options = normalizeOptions(seed);
    const applied = decideOptions({ options, configured: false, record: null });
    const view = pageOptionsView({
      options,
      record: applied.record ?? null,
      decision: applied,
      networkConfigured: true,
      secretSet: true,
      nodeId: "node-1",
    });
    expect(view.applied).toBe(true);
    expect(view.drift).toBe(false);
    expect(view.source).toBe("seed");
    expect(view.secretSet).toBe(true);

    const drifted = pageOptionsView({
      options: normalizeOptions({ ...seed, peers: ["tcp://changed:1"] }),
      record: applied.record ?? null,
      decision: { kind: "none", reason: "existing state wins" },
      networkConfigured: true,
      secretSet: true,
      nodeId: "node-1",
    });
    expect(drifted.applied).toBe(false);
    expect(drifted.drift).toBe(true);
  });

  test("options.js is a plain assignment that cannot close the script tag early", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmyaihub-page-"));
    const options = normalizeOptions({ networkName: "</script><script>alert(1)</script>" });
    writePageOptions(
      pageOptionsView({ options, record: null, decision: { kind: "none", reason: "x" }, networkConfigured: false, secretSet: false, nodeId: null }),
      dir,
    );
    const body = readFileSync(join(dir, "options.js"), "utf8");
    expect(body).not.toContain("</script>");
    expect(body).toContain("window.__OH_MY_AIHUB_OPTIONS__");
    // it must be valid JavaScript that assigns the object
    const sandbox: Record<string, unknown> = {};
    new Function("window", body)(sandbox);
    const parsed = sandbox.__OH_MY_AIHUB_OPTIONS__ as { networkConfigured: boolean };
    expect(parsed.networkConfigured).toBe(false);
  });

  test("free text on the page is masked and bounded, and the file is 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmyaihub-page-"));
    writePageOptions(
      pageOptionsView({
        options: normalizeOptions({}),
        record: null,
        decision: {
          kind: "none",
          reason: "configure failed at /Users/someone/.config/magpie: GET https://rpc.example/key-abc returned 401 for 0x1234567890abcdef1234567890abcdef12345678",
        },
        networkConfigured: false,
        secretSet: false,
        nodeId: null,
      }),
      dir,
    );
    const file = join(dir, "options.js");
    const body = readFileSync(file, "utf8");
    // the file escapes `<`, so the masked text is checked where the page reads it
    const sandbox: Record<string, unknown> = {};
    new Function("window", body)(sandbox);
    const shown = sandbox.__OH_MY_AIHUB_OPTIONS__ as { reason: string };
    expect(shown.reason).toContain("<path>");
    expect(shown.reason).toContain("<url>");
    expect(shown.reason).toContain("<address>");
    expect(body).not.toContain("/Users/someone");
    expect(body).not.toContain("https://rpc.example");
    expect(body).not.toContain("0x1234567890abcdef");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("maskPageText truncates and never returns a secret", () => {
    const long = `${"x".repeat(400)} /tmp/private/thing`;
    const masked = maskPageText(long);
    expect(masked?.endsWith("…")).toBe(true);
    expect(masked?.length).toBeLessThanOrEqual(301);
    expect(maskPageText("sk-abcdefghijklmnop")?.includes("abcdefghijklmnop")).toBe(false);
    expect(maskPageText(null)).toBeNull();
  });

  test("never carries the secret into the page file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmyaihub-page-"));
    const options = normalizeOptions(seed);
    writePageOptions(
      pageOptionsView({
        options,
        record: record(options),
        decision: { kind: "none", reason: "x" },
        networkConfigured: true,
        secretSet: true,
        nodeId: "node-1",
      }),
      dir,
    );
    const body = readFileSync(join(dir, "options.js"), "utf8");
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("networkSecret");
    expect(body).toContain('"secretSet":true');
  });
});

describe("the key sets the page and the host agree on", () => {
  test("the seed keys are a subset of the config keys, which are a subset of the digest keys", () => {
    for (const k of SEED_KEYS) expect(CONFIG_KEYS).toContain(k as never);
    for (const k of CONFIG_KEYS) expect(DIGEST_KEYS).toContain(k);
  });

  test("a seed patch never invents a key outside the config set", () => {
    const patch = seedPatch(normalizeOptions({ ...seed, pagePrefs: { showAdvanced: true } })) ?? {};
    for (const k of Object.keys(patch)) expect(CONFIG_KEYS).toContain(k as never);
    expect(patch).not.toHaveProperty("pagePrefs");
  });

  test("the record never stores the secret in the page view", () => {
    const options = normalizeOptions(seed);
    const d = decideOptions({ options, configured: false, record: null });
    const view = pageOptionsView({
      options,
      record: d.record ?? null,
      decision: d,
      networkConfigured: true,
      secretSet: true,
      nodeId: null,
    });
    expect(JSON.stringify(view)).not.toContain(SECRET);
    // the host's own record may hold it (it is how the diff knows what changed),
    // and it lives in a 0600 file under the plugin's state directory
    expect(JSON.stringify(d.record)).toContain(SECRET);
  });
});
