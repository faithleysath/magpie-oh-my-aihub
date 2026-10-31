import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { startControlApp, type ControlApp } from "../src/control/app.ts";
import { PRESENCE_SCHEMA, signPresence, verifyPresence, type PresenceBody } from "../src/control/presence.ts";
import { loadPresenceTrust } from "../src/control/presence-trust.ts";
import type { CatalogIdentity } from "../src/catalog.ts";
import type { Service } from "../src/service.ts";

const prev = process.cwd();
let apps: ControlApp[] = [];
beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), "control-app-"))); });
afterAll(async () => {
  for (const app of apps.splice(0)) await app.stop();
  process.chdir(prev);
});

function fakeService() {
  let presence: (() => unknown | null) | null = null;
  const calls: string[] = [];
  let controlActive = false;
  const cfg: { nodeId: string; hostname: string; mappedCidr: string | null; controlEnabled: boolean; controlPort: number | null; sharingEnabled: boolean; catalog: { port: number; socksPort: number } } = { nodeId: "abcd1234", hostname: "ohmyaihub-abcd1234", mappedCidr: null, controlEnabled: true, controlPort: null, sharingEnabled: false, catalog: { port: 3426, socksPort: 13400 } };
  const service = {
    config: () => cfg,
    catalogStatus: () => ({ quote: null, peers: [] }),
    setControlPresence: (fn: (() => unknown | null) | null) => { presence = fn; },
    setControlPort: (port: number) => { cfg.controlPort = port; calls.push(`port:${port}`); },
    setControlActive: (active: boolean) => { controlActive = active; calls.push(`active:${active}`); },
    applyControlPublication: async () => { calls.push(`publish:${controlActive}`); },
    gatewayPort: () => 3425,
    providers: () => [],
    statusSnapshotForTest: () => ({ config: { sharingEnabled: false, shareSuspended: null } }),
    approveConnectionRequest: async () => { throw new Error("not used"); },
    handover: async () => { throw new Error("not used"); },
    addProvider: async () => { throw new Error("not used"); },
    providerModels: async () => { throw new Error("not used"); },
    removeProvider: async () => { throw new Error("not used"); },
    provisioner: {},
  } as unknown as Service;
  return { service, presence: () => presence, calls, controlActive: () => controlActive };
}

describe("control app lifecycle", () => {
  test("starts a bounded control listener and publishes signed presence only through the callback", async () => {
    const { service, presence, calls } = fakeService();
    const app = await startControlApp(service, { host: "127.0.0.1" });
    expect(app).not.toBeNull();
    apps.push(app!);
    const health = await fetch(`http://127.0.0.1:${app!.port}/p2p/v1/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).ok).toBe(true);
    const fn = presence();
    expect(typeof fn).toBe("function");
    const doc = fn!() as Record<string, unknown>;
    const verified = verifyPresence(doc, new Date(), { allowLoopback: true });
    expect(verified.node.nodeId).toBe("abcd1234");
    expect(verified.endpoint.controlPort).toBe(app!.port);
    expect(verified.capability.providesModels).toBe(false);
    const state = await app!.state();
    expect(state.schema).toBe("ohmyaihub/p2p-state/1");
    expect((state.listener as Record<string, unknown>).reachability).toBe("loopback");
    // The listener is published (never implicitly): the control app marks the
    // plane active and asks the service to apply the bounded publication.
    expect(calls).toContain(`port:${app!.port}`);
    expect(calls).toContain("active:true");
    expect(calls).toContain("publish:true");
    await app!.stop();
    expect(calls).toContain("active:false");
    expect(calls).toContain("publish:false");
  });
});

function otherIdentity(): CatalogIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  const raw = Buffer.from(jwk.x!, "base64url");
  const fingerprint = createHash("sha256").update(raw).digest("hex");
  return {
    summary: { algorithm: "ed25519", publicKey: raw.toString("base64"), fingerprint, keyId: fingerprint.slice(0, 16), createdAt: "2026-10-31T00:00:00.000Z" },
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

function neighbourPresence(identity: CatalogIdentity, over: Partial<PresenceBody> = {}): PresenceBody {
  return {
    schema: PRESENCE_SCHEMA,
    node: { nodeId: "bbbb2222", hostname: "ohmyaihub-bbbb2222", fingerprint: identity.summary.fingerprint, publicKey: identity.summary.publicKey },
    endpoint: { host: "10.66.1.3", mappedCidr: "10.66.1.3/32", controlPort: 35210, ready: true },
    capability: { control: true, sharing: "disabled", providesModels: false },
    issuedAt: "2026-10-31T11:59:40.000Z",
    expiresAt: "2026-10-31T12:01:40.000Z",
    ...over,
  };
}

describe("control-only neighbour presence", () => {
  test("is discovered from its signature, pinned on first sight, and accepted only by a human", async () => {
    const { service } = fakeService();
    const now = new Date("2026-10-31T12:00:00.000Z");
    const identity = otherIdentity();
    let doc = signPresence(neighbourPresence(identity), identity);
    const ports: number[] = [];
    const app = await startControlApp(service, {
      host: "127.0.0.1",
      port: 35610,
      now: () => now,
      presenceHttpGet: async ({ port }) => {
        ports.push(port);
        return port === 3426 ? { status: 200, body: JSON.stringify(doc) } : { status: 404, body: "" };
      },
    });
    expect(app).not.toBeNull();
    apps.push(app!);

    const seen = await app!.probePresence("10.66.1.3/32", 3426);
    expect(seen.capability).toEqual({ control: true, sharing: "disabled", providesModels: false });
    expect(ports).toEqual([3426]);
    const pins = loadPresenceTrust();
    expect(pins["bbbb2222"].fingerprint).toBe(identity.summary.fingerprint);
    expect(pins["bbbb2222"].accepted).toBe(false);
    let state = await app!.state();
    const row = (state.presence as Record<string, unknown>[])[0];
    expect(row.tofu).toBe("first-seen");
    expect(row.presencePort).toBe(3426);
    expect(JSON.stringify(state)).not.toMatch(/sk-|secret|gatewayKey/i);

    app!.trustPresence("bbbb2222", identity.summary.fingerprint);
    state = await app!.state();
    expect((state.presence as Record<string, unknown>[])[0].tofu).toBe("accepted");

    // A different key is a change: reported, never accepted, and the accepted
    // fingerprint cannot be replaced by the new one without a human.
    const next = otherIdentity();
    doc = signPresence(neighbourPresence(next), next);
    await app!.probePresence("10.66.1.3/32", 3426);
    state = await app!.state();
    expect((state.presence as Record<string, unknown>[])[0].tofu).toBe("changed");
    // Accepting the still-trusted old key must not confirm the new one.
    app!.trustPresence("bbbb2222", identity.summary.fingerprint);
    let pins2 = loadPresenceTrust();
    expect(pins2["bbbb2222"].fingerprint).toBe(identity.summary.fingerprint);
    expect(pins2["bbbb2222"].pending?.fingerprint).toBe(next.summary.fingerprint);
    state = await app!.state();
    expect((state.presence as Record<string, unknown>[])[0].tofu).toBe("changed");
    expect(() => app!.trustPresence("bbbb2222", "0".repeat(64))).toThrow();
    app!.trustPresence("bbbb2222", next.summary.fingerprint);
    expect(loadPresenceTrust()["bbbb2222"].fingerprint).toBe(next.summary.fingerprint);
    expect(loadPresenceTrust()["bbbb2222"].accepted).toBe(true);
    await app!.stop();
  });

  test("an unsigned, tampered or off-address presence is refused and pins nothing", async () => {
    const { service } = fakeService();
    const now = new Date("2026-10-31T12:00:00.000Z");
    const identity = otherIdentity();
    const good = signPresence(neighbourPresence(identity), identity);
    let body = JSON.stringify({ ...good, capability: { ...good.capability, providesModels: true } });
    const app = await startControlApp(service, {
      host: "127.0.0.1",
      port: 35620,
      now: () => now,
      presenceHttpGet: async () => ({ status: 200, body }),
    });
    apps.push(app!);
    await expect(app!.probePresence("10.66.1.3/32", 3426)).rejects.toThrow(/invalid presence/);
    expect(loadPresenceTrust()["bbbb2222"]).toBeUndefined();
    // An unexpected mapped address is refused before any pin is written.
    body = JSON.stringify(signPresence(neighbourPresence(identity, { endpoint: { host: "10.66.1.9", mappedCidr: "10.66.1.9/32", controlPort: 35210, ready: true } }), identity));
    await expect(app!.probePresence("10.66.1.3/32", 3426)).rejects.toThrow();
    expect(loadPresenceTrust()["bbbb2222"]).toBeUndefined();
    await app!.stop();
  });
});
