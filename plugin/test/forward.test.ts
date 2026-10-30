import { describe, expect, test } from "bun:test";
import { decodeForward, decodeForwardAddr, renderConfig, overlayHostname, type EasytierConfig } from "../src/easytier.ts";

const cfg: EasytierConfig = {
  sharingEnabled: true,
  consumingEnabled: true,
  nodeId: "9f3a1b2c",
  instanceId: "87ede5a2-9c3d-492d-9bbe-989b9d07e742",
  networkName: "lab",
  networkSecret: "lab-secret-123",
  peers: [],
  virtualIpv4: "10.77.0.7/24",
  overlayCidr: "10.77.0.0/24",
  listenAddr: null,
  rpcPort: 17888,
  proxyCidr: "192.0.2.84/32",
  mappedCidr: "10.66.7.9/32",
  publishedPorts: [3425],
  socks5Proxy: null,
  portForwards: [{ bindAddr: "127.0.0.1:13425", dstAddr: "10.66.1.2:3425" }],
  secureMode: true,
  secureIdentity: { privateKey: "aa", publicKey: "bb" },
};

describe("EasyTier's forward JSON", () => {
  // EasyTier 2.6.4 prints the protobuf SocketAddr, not the table's string:
  //   {"bind_addr":{"port":13425,"ip":{"Ipv4":{"addr":2130706433}}}, …}
  test("decodes the nested protobuf address", () => {
    const bind = { port: 13425, ip: { Ipv4: { addr: 2130706433 } } }; // 127.0.0.1
    const dst = { port: 3425, ip: { Ipv4: { addr: 172097802 } } }; // 10.66.1.10
    expect(decodeForwardAddr(bind)).toBe("127.0.0.1:13425");
    expect(decodeForwardAddr(dst)).toBe("10.66.1.10:3425");
  });

  test("decodes a whole rule, and still accepts the string form", () => {
    const nested = {
      bind_addr: { port: 13425, ip: { Ipv4: { addr: 2130706433 } } },
      dst_addr: { port: 3425, ip: { Ipv4: { addr: 172097802 } } },
      socket_type: 0,
    };
    expect(decodeForward(nested)).toEqual({ protocol: "tcp", bindAddr: "127.0.0.1:13425", dstAddr: "10.66.1.10:3425" });
    expect(decodeForward({ bind_addr: "127.0.0.1:13425", dst_addr: "10.66.1.10:3425", proto: "tcp" })).toEqual({
      protocol: "tcp",
      bindAddr: "127.0.0.1:13425",
      dstAddr: "10.66.1.10:3425",
    });
  });

  test("an undecodable address is empty, never a half-parsed one", () => {
    expect(decodeForwardAddr(null)).toBe("");
    expect(decodeForwardAddr({ port: 1 })).toBe(":1");
    expect(decodeForwardAddr({})).toBe("");
  });
});

describe("generated identity", () => {
  test("the hostname and the instance id are persisted values, not the role", () => {
    const text = renderConfig(cfg);
    expect(text).toContain('hostname = "ohmyaihub-9f3a1b2c"');
    expect(text).toContain('instance_name = "ohmyaihub-9f3a1b2c"');
    expect(text).toContain('instance_id = "87ede5a2-9c3d-492d-9bbe-989b9d07e742"');
    expect(overlayHostname(cfg)).toBe("ohmyaihub-9f3a1b2c");
  });

  test("a forward is written into the config, so a core restart keeps it", () => {
    const text = renderConfig(cfg);
    expect(text).toContain("[[port_forward]]");
    expect(text).toContain('bind_addr = "127.0.0.1:13425"');
    expect(text).toContain('dst_addr = "10.66.1.2:3425"');
    const off = renderConfig({ ...cfg, consumingEnabled: false });
    expect(off).not.toContain("[[port_forward]]");
  });
});

describe("catalogue transport in the generated config", () => {
  test("renders the loopback SOCKS5 listener and the catalogue in the Forward ACL", () => {
    const text = renderConfig({
      ...cfg,
      socks5Proxy: "socks5://127.0.0.1:13400",
      publishedPorts: [3425, 3426],
    });
    expect(text).toContain('socks5_proxy = "socks5://127.0.0.1:13400"');
    expect(text).toContain('ports = ["3426"]');
    expect(text).toContain('name = "allow-3426"');
  });

  test("refuses a SOCKS5 listener that is not loopback", () => {
    expect(() => renderConfig({ ...cfg, socks5Proxy: "socks5://0.0.0.0:13400" })).toThrow(/not 127\.0\.0\.1/);
    expect(() => renderConfig({ ...cfg, socks5Proxy: "http://127.0.0.1:13400" })).toThrow(/not 127\.0\.0\.1/);
    expect(() => renderConfig({ ...cfg, socks5Proxy: "socks5://127.0.0.1" })).toThrow(/not 127\.0\.0\.1/);
  });
});
