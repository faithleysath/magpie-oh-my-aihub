import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getProviderKey,
  keyStoreFile,
  loadState,
  providerKeyRef,
  saveState,
  setProviderKey,
  stateFile,
  STATE_VERSION,
} from "../src/state.ts";

let dir: string;

function read(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeLegacy(state: unknown): void {
  mkdirSync(join(dir, "oh-my-aihub"), { recursive: true, mode: 0o700 });
  writeFileSync(stateFile(), JSON.stringify(state, null, 1), { mode: 0o600 });
}

const legacyProvider = {
  config: {
    role: "provider",
    networkName: "legacy-net",
    networkSecret: "test-network-secret",
    peers: ["tcp://relay.example.com:11010"],
    listenAddr: "tcp://127.0.0.1:11010",
    virtualIpv4: "10.77.0.44/24",
    overlayCidr: "10.77.0.0/24",
    rpcPort: 17890,
    mappedCidr: "10.66.7.7/32",
    proxyCidr: "192.0.2.44/32",
    publishedPorts: [3425],
    secureMode: true,
    secureIdentity: { privateKey: "a-key", publicKey: "a-pub" },
  },
  consumers: ["alice"],
  providerWiring: null,
};

const legacyConsumer = {
  config: {
    ...legacyProvider.config,
    role: "consumer",
    mappedCidr: null,
    proxyCidr: null,
    publishedPorts: [],
  },
  consumers: [],
  providerWiring: {
    id: "peer-a",
    mappedCidr: "10.66.1.2/32",
    providerPort: 3425,
    key: "sk-test-legacy-consumer-key",
    localPort: 13425,
    createdAt: "2026-10-30T00:00:00.000Z",
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ohmyaihub-state-"));
  process.chdir(dir);
});

describe("phase-3 migration", () => {
  test("a provider-only node keeps sharing, gains a node id, and is backed up", () => {
    writeLegacy(legacyProvider);
    const loaded = loadState();
    const cfg = loaded.state.config!;
    expect(loaded.migratedFrom).toBe(1);
    expect(loaded.backupPath).not.toBeNull();
    expect(existsSync(loaded.backupPath!)).toBe(true);
    // The backup is the untouched phase-3 document.
    const backup = read(loaded.backupPath!);
    expect(backup.config.role).toBe("provider");
    expect(backup.providerWiring).toBeNull();

    expect(cfg.sharingEnabled).toBe(true);
    expect(cfg.consumingEnabled).toBe(false);
    expect(cfg.mappedCidr).toBe("10.66.7.7/32");
    expect(cfg.proxyCidr).toBe("192.0.2.44/32");
    expect(cfg.publishedPorts).toEqual([3425]);
    expect(cfg.secureIdentity).toEqual({ privateKey: "a-key", publicKey: "a-pub" });
    expect(cfg.nodeId).toMatch(/^[0-9a-f]{8}$/);
    expect(cfg.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(cfg.share.models).toEqual(["*"]);

    const onDisk = read(stateFile());
    expect(onDisk.version).toBe(STATE_VERSION);
    expect(onDisk.config.role).toBeUndefined();
    expect(onDisk.providerWiring).toBeUndefined();
    expect(onDisk.consumers).toEqual(["alice"]);
  });

  test("a consumer's old wiring becomes a provider record and its key leaves state.json", () => {
    writeLegacy(legacyConsumer);
    const loaded = loadState();
    const cfg = loaded.state.config!;
    expect(cfg.sharingEnabled).toBe(false);
    expect(cfg.consumingEnabled).toBe(true);
    expect(loaded.state.providers).toHaveLength(1);
    const p = loaded.state.providers[0];
    expect(p.id).toBe("peer-a");
    expect(p.mappedCidr).toBe("10.66.1.2/32");
    expect(p.localPort).toBe(13425);
    expect(p.keyRef).toBe(providerKeyRef("peer-a"));
    expect(p.status).toBe("degraded");
    expect(getProviderKey("peer-a")).toBe("sk-test-legacy-consumer-key");

    // the secret is not in the document any more
    const raw = readFileSync(stateFile(), "utf8");
    expect(raw).not.toContain("sk-test-legacy-consumer-key");
    expect(readFileSync(keyStoreFile(), "utf8")).toContain("sk-test-legacy-consumer-key");
  });

  test("migration is idempotent: a second load changes nothing", () => {
    writeLegacy(legacyConsumer);
    const first = loadState();
    expect(first.migratedFrom).toBe(1);
    const second = loadState();
    expect(second.migratedFrom).toBeNull();
    expect(second.state.config!.nodeId).toBe(first.state.config!.nodeId);
    expect(second.state.config!.instanceId).toBe(first.state.config!.instanceId);
    expect(second.state.providers).toEqual(first.state.providers);
  });

  test("a v2 document loads as-is", () => {
    const loaded = loadState();
    const cfg = loaded.state.config;
    expect(cfg).toBeNull();
    setProviderKey("x", "sk-a-secret-value");
    const st = loaded.state;
    st.config = {
      sharingEnabled: true,
      consumingEnabled: true,
      nodeId: "abcd1234",
      instanceId: "11111111-2222-3333-4444-555555555555",
      networkName: "n",
      networkSecret: "test-network-secret-2",
      peers: [],
      listenAddr: null,
      virtualIpv4: "10.77.0.9/24",
      overlayCidr: "10.77.0.0/24",
      rpcPort: 17888,
      proxyCidr: "192.0.2.9/32",
      mappedCidr: "10.66.9.9/32",
      publishedPorts: [3425],
      secureMode: false,
      secureIdentity: null,
      share: { models: ["alpha/*"] },
    };
    saveState(st);
    const again = loadState();
    expect(again.migratedFrom).toBeNull();
    expect(again.state.config!.sharingEnabled).toBe(true);
    expect(again.state.config!.share.models).toEqual(["alpha/*"]);
  });
});

describe("crash safety", () => {
  test("writes leave no temporary files behind", () => {
    saveState({ version: STATE_VERSION, config: null, consumers: [], providers: [], orphanForwards: [], shareSuspended: null });
    const names = readdirSync(join(dir, "oh-my-aihub"));
    expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("an unreadable state.json is recovered from the previous copy", () => {
    writeLegacy(legacyProvider);
    loadState(); // migrates and writes .prev
    writeFileSync(stateFile(), "{ this is not json", { mode: 0o600 });
    const recovered = loadState();
    expect(recovered.recoveredFromPrevious).toBe(true);
    expect(recovered.state.config!.networkName).toBe("legacy-net");
  });

  test("an unreadable document with no previous copy starts empty, without throwing", () => {
    mkdirSync(join(dir, "oh-my-aihub"), { recursive: true, mode: 0o700 });
    writeFileSync(stateFile(), "not json at all", { mode: 0o600 });
    const loaded = loadState();
    expect(loaded.state.config).toBeNull();
    expect(loaded.state.providers).toEqual([]);
    expect(loaded.error).toBeTruthy();
  });

  test("the key store is separate and keeps only its own ids", () => {
    setProviderKey("a", "sk-test-store-a");
    setProviderKey("b", "sk-test-store-b");
    saveState({ version: STATE_VERSION, config: null, consumers: [], providers: [], orphanForwards: [], shareSuspended: null });
    const store = read(keyStoreFile());
    expect(Object.keys(store.keys).sort()).toEqual(["a", "b"]);
    const raw = readFileSync(stateFile(), "utf8");
    expect(raw).not.toContain("sk-test-store-a");
    expect(raw).not.toContain("sk-test-store-b");
  });
});
