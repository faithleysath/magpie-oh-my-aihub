import { describe, expect, test } from "bun:test";
import { checkConfig, type AclExpectation } from "../src/acl.ts";
import { renderConfig, type EasytierConfig } from "../src/easytier.ts";

const provider: EasytierConfig = {
  role: "provider",
  networkName: "lab",
  networkSecret: "supersecret",
  peers: ["tcp://relay.example.com:11010"],
  virtualIpv4: "10.77.0.7/24",
  overlayCidr: "10.77.0.0/24",
  listenAddr: "tcp://127.0.0.1:11010",
  rpcPort: 17888,
  proxyCidr: "192.0.2.84/32",
  mappedCidr: "10.66.7.9/32",
  publishedPorts: [3425],
  secureMode: true,
  secureIdentity: { privateKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
  instanceName: "ohmyaihub-provider",
};

const consumer: EasytierConfig = {
  ...provider,
  role: "consumer",
  proxyCidr: null,
  mappedCidr: null,
  publishedPorts: [],
  instanceName: "ohmyaihub-consumer",
};

const expectProvider: AclExpectation = {
  role: "provider",
  publishedPorts: [3425],
  proxy: { cidr: "192.0.2.84/32", mappedCidr: "10.66.7.9/32" },
  secureMode: true,
  networkName: "lab",
};
const expectConsumer: AclExpectation = { role: "consumer", publishedPorts: [], proxy: null, secureMode: true, networkName: "lab" };

const good = renderConfig(provider);
const goodConsumer = renderConfig(consumer);

describe("generated configurations", () => {
  test("the provider's passes, and it says what it must", () => {
    const r = checkConfig(good, expectProvider);
    expect(r).toEqual({ ok: true, problems: [] });
    expect(good).toContain("no_tun = true");
    expect(good).not.toContain("tcp_whitelist");
    expect(good).toContain('mapped_cidr = "10.66.7.9/32"');
  });

  test("the consumer's passes and exports nothing", () => {
    expect(checkConfig(goodConsumer, expectConsumer)).toEqual({ ok: true, problems: [] });
    expect(goodConsumer).not.toContain("proxy_network");
  });

  test("the validator refuses a file that is not TOML at all", () => {
    expect(checkConfig("not toml = = =", expectProvider).ok).toBe(false);
  });
});

describe("ACL must fail closed", () => {
  const mutate = (from: string, to: string) => good.replace(from, to);

  test("tcp_whitelist is refused", () => {
    const r = checkConfig('tcp_whitelist = ["3425"]\n' + good, expectProvider);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("tcp_whitelist");
  });

  test("a missing Inbound chain is refused", () => {
    const cut = good.lastIndexOf("[[acl.acl_v1.chains]]");
    const withoutInbound = good.slice(0, cut);
    const r = checkConfig(withoutInbound, expectProvider);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("no Inbound chain");
  });

  test("any Inbound rule is refused, even an allow for the gateway port", () => {
    const withRule = good + '\n[[acl.acl_v1.chains.rules]]\nname = "oops"\nprotocol = 1\nports = ["3425"]\naction = 1\n';
    expect(checkConfig(withRule, expectProvider).ok).toBe(false);
  });

  test("a second Inbound chain with a hidden allow is refused", () => {
    const hidden =
      good +
      '\n[[acl.acl_v1.chains]]\nname = "Inbound-2"\nchain_type = 1\nenabled = false\ndefault_action = 2\n' +
      '[[acl.acl_v1.chains.rules]]\nprotocol = 1\nports = ["3425"]\naction = 1\n';
    const r = checkConfig(hidden, expectProvider);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("must have none");
  });

  test("an Inbound chain that defaults to Allow is refused", () => {
    const bad = good.replace(/(name = "Inbound"[\s\S]*?)default_action = 2/, "$1default_action = 1");
    expect(checkConfig(bad, expectProvider).ok).toBe(false);
  });

  test("a Forward chain that defaults to Allow is refused", () => {
    const bad = good.replace(/(name = "Forward"[\s\S]*?)default_action = 2/, "$1default_action = 1");
    expect(checkConfig(bad, expectProvider).ok).toBe(false);
  });

  test("an extra allowed port is refused", () => {
    const bad = good + '\n[[acl.acl_v1.chains]]\nname = "Forward-2"\nchain_type = 3\ndefault_action = 2\n' +
      '[[acl.acl_v1.chains.rules]]\nprotocol = 1\nports = ["22"]\naction = 1\n';
    const r = checkConfig(bad, expectProvider);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("allows [22, 3425]");
  });

  test("a port range is refused", () => {
    const bad = good.replace('ports = ["3425"]', 'ports = ["3000-4000"]');
    expect(checkConfig(bad, expectProvider).ok).toBe(false);
  });

  test("a non-TCP allow is refused", () => {
    const bad = good.replace("protocol = 1", "protocol = 2");
    expect(checkConfig(bad, expectProvider).ok).toBe(false);
  });

  test("an address-scoped allow is refused", () => {
    const bad = good.replace('ports = ["3425"]', 'ports = ["3425"]\ndestination_ips = ["203.0.113.0/24"]');
    expect(checkConfig(bad, expectProvider).ok).toBe(false);
  });

  test("a provider without a Forward chain is refused", () => {
    const forward = good.indexOf("[[acl.acl_v1.chains]]");
    const inbound = good.lastIndexOf("[[acl.acl_v1.chains]]");
    const withoutForward = good.slice(0, forward) + good.slice(inbound);
    const r = checkConfig(withoutForward, expectProvider);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("needs a Forward chain");
  });

  test("a consumer with a Forward allow or an export is refused", () => {
    const withExport = 'proxy_network = [{ cidr = "192.0.2.84/32" }]\n' + goodConsumer;
    expect(checkConfig(withExport, expectConsumer).ok).toBe(false);
    const withForward = goodConsumer + '\n[[acl.acl_v1.chains]]\nname = "Forward"\nchain_type = 3\ndefault_action = 2\n' +
      '[[acl.acl_v1.chains.rules]]\nprotocol = 1\nports = ["3425"]\naction = 1\n';
    expect(checkConfig(withForward, expectConsumer).ok).toBe(false);
  });

  test("EasyTier's /32 normalization still passes", () => {
    // the running core reports a single-host CIDR without "/32"
    const normalized = good
      .replace('cidr = "192.0.2.84/32"', 'cidr = "192.0.2.84"')
      .replace('mapped_cidr = "10.66.7.9/32"', 'mapped_cidr = "10.66.7.9"');
    expect(checkConfig(normalized, expectProvider)).toEqual({ ok: true, problems: [] });
  });

  test("a different or extra export is refused", () => {
    const other = good.replace('mapped_cidr = "10.66.7.9/32"', 'mapped_cidr = "10.66.9.9/32"');
    expect(checkConfig(other, expectProvider).ok).toBe(false);
    const two = good.replace('proxy_network = ', 'proxy_network = [{ cidr = "198.51.100.0/24" }, ');
    expect(checkConfig(two, expectProvider).ok).toBe(false);
  });

  test("no_tun other than true is refused", () => {
    expect(checkConfig(good.replace("no_tun = true", "no_tun = false"), expectProvider).ok).toBe(false);
    expect(checkConfig(good.replace("no_tun = true\n", ""), expectProvider).ok).toBe(false);
  });

  test("forward_by_system and disabled encryption are refused", () => {
    expect(checkConfig(good.replace("[flags]", "[flags]\nforward_by_system = true"), expectProvider).ok).toBe(false);
    expect(checkConfig(good.replace("[flags]", "[flags]\ndisable_encryption = true"), expectProvider).ok).toBe(false);
  });

  test("Secure Mode must be on with a pinned keypair", () => {
    const noSecure = good.replace(/\[secure_mode\][\s\S]*?(?=\[acl)/, "");
    expect(checkConfig(noSecure, expectProvider).ok).toBe(false);
    const noKeys = good.replace(/local_private_key = .*\n/, "").replace(/local_public_key = .*\n/, "");
    expect(checkConfig(noKeys, expectProvider).ok).toBe(false);
  });

  test("a different network name or an unknown chain type is refused", () => {
    expect(checkConfig(good.replace('network_name = "lab"', 'network_name = "other"'), expectProvider).ok).toBe(false);
    expect(checkConfig(good.replace("chain_type = 3", "chain_type = 9"), expectProvider).ok).toBe(false);
  });
});
