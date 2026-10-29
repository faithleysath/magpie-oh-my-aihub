import { describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { checkAclInvariants, renderConfig, randomMappedCidr, randomVirtualIp, generateSecureIdentity } from "../src/easytier.ts";
import type { EasytierConfig } from "../src/easytier.ts";

const base: EasytierConfig = {
  role: "provider",
  networkName: "lab",
  networkSecret: "supersecret",
  peers: [],
  virtualIpv4: "10.77.0.7/24",
  overlayCidr: "10.77.0.0/24",
  listenAddr: null,
  rpcPort: 17888,
  proxyCidr: "192.168.1.20/32",
  mappedCidr: "10.66.7.9/32",
  publishedPorts: [3425],
  secureMode: true,
  secureIdentity: {
    privateKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
  },
  instanceName: "ohmyaihub-provider",
};

describe("renderConfig", () => {
  const text = renderConfig(base);

  test("no TUN, no whitelist, secured and mapped", () => {
    expect(text).toContain("no_tun = true");
    expect(text).not.toContain("tcp_whitelist");
    expect(text).not.toContain("udp_whitelist");
    expect(text).toContain('mapped_cidr = "10.66.7.9/32"');
    expect(text).toContain("enabled = true");
    expect(text).toContain("local_private_key");
  });

  test("Forward chain allows exactly the published ports and defaults to Drop", () => {
    expect(text).toContain('name = "Forward"');
    expect(text).toContain("default_action = 2");
    expect(text).toContain('ports = ["3425"]');
  });

  test("Inbound chain has no rules and defaults to Drop", () => {
    const inbound = text.split('name = "Inbound"')[1] ?? "";
    expect(inbound).toContain("default_action = 2");
    expect(inbound).not.toContain("[[acl.acl_v1.chains.rules]]");
  });

  test("passes its own invariants", () => {
    expect(checkAclInvariants(text)).toEqual({ ok: true, problems: [] });
  });

  test("a consumer has no Forward chain and exports nothing", () => {
    const c = renderConfig({ ...base, role: "consumer", proxyCidr: null, mappedCidr: null, publishedPorts: [] });
    expect(c).not.toContain('name = "Forward"');
    expect(c).not.toContain("proxy_network");
    expect(c).toContain('name = "Inbound"');
    expect(checkAclInvariants(c).ok).toBe(true);
  });
});

describe("checkAclInvariants", () => {
  const good = renderConfig(base);

  test("rejects tcp_whitelist", () => {
    const bad = good.replace("[flags]", 'tcp_whitelist = ["3425"]\n[flags]');
    expect(checkAclInvariants(bad).ok).toBe(false);
    expect(checkAclInvariants(bad).problems.join(" ")).toContain("tcp_whitelist");
  });

  test("rejects a missing Inbound chain", () => {
    const bad = good.replace(/\[\[acl\.acl_v1\.chains\]\]\nname = "Inbound"[\s\S]*$/, "");
    expect(checkAclInvariants(bad).ok).toBe(false);
    expect(checkAclInvariants(bad).problems.join(" ")).toContain("no Inbound chain");
  });

  test("rejects an Inbound rule, even an allow for the gateway port", () => {
    const bad = good + '\n[[acl.acl_v1.chains.rules]]\nname = "oops"\nprotocol = 1\nports = ["3425"]\naction = 1\n';
    expect(checkAclInvariants(bad).ok).toBe(false);
  });

  test("rejects an Inbound chain that defaults to Allow", () => {
    const bad = good.replace(/(name = "Inbound"[\s\S]*?)default_action = 2/, "$1default_action = 1");
    expect(checkAclInvariants(bad).ok).toBe(false);
  });

  test("rejects a Forward chain that defaults to Allow", () => {
    const bad = good.replace(/(name = "Forward"[\s\S]*?)default_action = 2/, "$1default_action = 1");
    expect(checkAclInvariants(bad).ok).toBe(false);
  });

  test("rejects forward_by_system", () => {
    const bad = good.replace("no_tun = true", "no_tun = true\nforward_by_system = true");
    expect(checkAclInvariants(bad).ok).toBe(false);
  });
});

describe("address allocation", () => {
  test("mapped cidrs are unique and in 10.66.0.0/16", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const c = randomMappedCidr(seen);
      expect(c).toMatch(/^10\.66\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])\/32$/);
      seen.add(c);
    }
    expect(seen.size).toBe(50);
  });

  test("virtual addresses stay inside the overlay /24 and skip .0/.1/.255", () => {
    for (let i = 0; i < 50; i++) {
      const v = randomVirtualIp("10.77.0.0/24");
      const host = Number(v.split("/")[0].split(".")[3]);
      expect(host).toBeGreaterThanOrEqual(2);
      expect(host).toBeLessThanOrEqual(253);
      expect(v.endsWith("/24")).toBe(true);
    }
  });

  test("a secure identity is a matching X25519 pair in base64", () => {
    const { privateKey, publicKey } = generateSecureIdentity();
    expect(Buffer.from(privateKey, "base64")).toHaveLength(32);
    expect(Buffer.from(publicKey, "base64")).toHaveLength(32);
    // PKCS#8 for a raw X25519 private key: a fixed prefix and the 32 bytes.
    const prefix = Buffer.from("302e020100300506032b656e04220420", "hex");
    const der = Buffer.concat([prefix, Buffer.from(privateKey, "base64")]);
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const derived = createPublicKey(key).export({ format: "jwk" }).x;
    expect(derived).toBe(Buffer.from(publicKey, "base64").toString("base64url"));
  });
});
