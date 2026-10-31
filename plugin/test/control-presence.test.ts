import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateCatalogIdentity } from "../src/catalog.ts";
import { PRESENCE_SCHEMA, signPresence, verifyPresence, type PresenceBody } from "../src/control/presence.ts";

const prev = process.cwd();
let now: Date;
beforeEach(() => {
  process.chdir(mkdtempSync(join(tmpdir(), "presence-test-")));
  now = new Date("2026-10-31T12:00:00.000Z");
});
afterAll(() => process.chdir(prev));

function body(): PresenceBody {
  const id = loadOrCreateCatalogIdentity();
  return {
    schema: PRESENCE_SCHEMA,
    node: { nodeId: "aaaa1111", hostname: "ohmyaihub-aaaa1111", fingerprint: id.summary.fingerprint, publicKey: id.summary.publicKey },
    endpoint: { host: "192.168.1.10", mappedCidr: "10.66.1.2/32", controlPort: 35210, ready: true },
    capability: { control: true, sharing: "enabled", providesModels: true },
    issuedAt: "2026-10-31T11:59:30.000Z",
    expiresAt: "2026-10-31T12:01:30.000Z",
  };
}

describe("signed control presence", () => {
  test("signs and verifies the exact node/endpoint/capability without model or key", () => {
    const id = loadOrCreateCatalogIdentity();
    const doc = signPresence(body(), id);
    expect(JSON.stringify(doc)).not.toMatch(/sk-|gatewayKey|secret|modelId/);
    const verified = verifyPresence(doc, now);
    expect(verified.node.nodeId).toBe("aaaa1111");
    expect(verified.endpoint.controlPort).toBe(35210);
    expect(verified.capability.control).toBe(true);
  });

  test("rejects tampering, extra fields, wrong fingerprint, stale and unready endpoints", () => {
    const id = loadOrCreateCatalogIdentity();
    const doc = signPresence(body(), id);
    for (const bad of [
      { ...doc, node: { ...doc.node, fingerprint: "0".repeat(64) } },
      { ...doc, endpoint: { ...doc.endpoint, controlPort: 35211 } },
      { ...doc, capability: { ...doc.capability, providesModels: false } },
      { ...doc, extra: true },
      { ...doc, endpoint: { ...doc.endpoint, ready: false } },
    ]) {
      expect(() => verifyPresence(bad, now)).toThrow();
    }
    expect(() => verifyPresence(doc, new Date("2026-10-31T12:05:00.000Z"))).toThrow(/current/);
    const future = signPresence({ ...body(), issuedAt: "2026-10-31T12:00:00.000Z", expiresAt: "2026-10-31T12:01:00.000Z" }, id);
    expect(() => verifyPresence(future, new Date("2026-10-31T11:50:00.000Z"))).toThrow();
  });
});
