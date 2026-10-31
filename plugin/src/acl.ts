// Strict validation of an EasyTier configuration, taken from real TOML.
//
// The properties this project depends on are not "the file contains the right
// words": every chain of every type is checked, the ports the Forward chain can
// reach must be exactly the ones the plugin publishes, and anything that cannot
// be parsed or cannot be proven safe is a failure. The caller must treat a
// failure as "do not serve", never as a warning (fail closed).

export interface AclExpectation {
  /** this node publishes its gateway on the overlay */
  sharingEnabled: boolean;
  /** this node publishes an overlay export; defaults to sharingEnabled */
  exportEnabled?: boolean;
  /** the gateway ports this node may expose through the Forward chain */
  publishedPorts: number[];
  /** this node's export, or null when it shares nothing */
  proxy: { cidr: string; mappedCidr: string } | null;
  /** the loopback forwards this node's config must contain (a subset is enough) */
  portForwards: { bindAddr: string; dstAddr: string }[];
  secureMode: boolean;
  networkName: string;
}

export interface AclCheck {
  ok: boolean;
  problems: string[];
}

interface Chain {
  name?: unknown;
  chain_type?: unknown;
  enabled?: unknown;
  default_action?: unknown;
  rules?: unknown;
}

interface Rule {
  name?: unknown;
  enabled?: unknown;
  protocol?: unknown;
  ports?: unknown;
  action?: unknown;
  source_ips?: unknown;
  source_ports?: unknown;
  destination_ips?: unknown;
}

const CHAIN_INBOUND = 1;
const CHAIN_OUTBOUND = 2;
const CHAIN_FORWARD = 3;
const ACTION_ALLOW = 1;
const ACTION_DROP = 2;
const PROTO_TCP = 1;

function parseToml(text: string): { value: unknown; error: string | null } {
  const api = (globalThis as { Bun?: { TOML?: { parse?: (s: string) => unknown } } }).Bun?.TOML;
  if (!api?.parse) {
    // Fail closed: without a parser nothing can be proven about the file.
    return { value: null, error: "this Bun has no TOML parser (Bun.TOML), so the configuration cannot be verified" };
  }
  try {
    return { value: api.parse(text), error: null };
  } catch (e) {
    return { value: null, error: `the configuration is not valid TOML: ${(e as Error).message}` };
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** EasyTier writes a single-host CIDR back without "/32"; compare prefixes. */
function samePrefix(value: unknown, expected: string): boolean {
  const norm = (v: string) => {
    const s = v.trim();
    return s.includes("/") ? s : `${s}/32`;
  };
  return norm(String(value ?? "")) === norm(expected);
}

function portList(ports: unknown): number[] | null {
  if (!Array.isArray(ports)) return null;
  const out: number[] = [];
  for (const p of ports) {
    if (typeof p !== "string" && typeof p !== "number") return null;
    const s = String(p).trim();
    const m = /^(\d{1,5})$/.exec(s);
    if (!m) return null; // ranges and anything else are not something we generate
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    out.push(n);
  }
  return out;
}

/** Which chains EasyTier treats as the default for their type: the first enabled one. */
function firstEnabled(chains: Chain[], type: number): Chain | null {
  for (const c of chains) {
    if (c.chain_type === type && c.enabled !== false) return c;
  }
  return null;
}

export function checkConfig(text: string, expect: AclExpectation): AclCheck {
  const problems: string[] = [];
  const { value, error } = parseToml(text);
  if (error) return { ok: false, problems: [error] };
  const root = asRecord(value);
  if (!root) return { ok: false, problems: ["the configuration is not a TOML table"] };

  // --- transport flags -------------------------------------------------------
  const flags = asRecord(root.flags) ?? {};
  if (flags.no_tun !== true) problems.push("flags.no_tun is not true");
  if (flags.forward_by_system) problems.push("flags.forward_by_system is set: the internal proxy (and its ACL) would be bypassed");
  if (flags.disable_encryption) problems.push("flags.disable_encryption is set");
  if (root.tcp_whitelist !== undefined || root.udp_whitelist !== undefined) {
    problems.push("tcp_whitelist/udp_whitelist is present: it compiles to Inbound allow rules");
  }

  const identity = asRecord(root.network_identity);
  if (!identity) problems.push("network_identity is missing");
  else if (identity.network_name !== expect.networkName) {
    problems.push(`network name is ${String(identity.network_name)}, expected ${expect.networkName}`);
  }
  if (expect.secureMode) {
    const secure = asRecord(root.secure_mode);
    if (!secure || secure.enabled !== true) problems.push("secure_mode is not enabled");
    else if (!secure.local_private_key || !secure.local_public_key) {
      problems.push("secure_mode has no pinned local keypair");
    }
  }

  // --- exports ---------------------------------------------------------------
  // A control-only node exports an address for its bounded presence/control
  // ports; it never exports a gateway or a catalogue. The export/Forward checks
  // therefore follow "does this node export?", not "does it share models?".
  const exporting = expect.exportEnabled ?? expect.sharingEnabled;
  const proxy = asArray(root.proxy_network);
  if (exporting) {
    if (!expect.proxy) problems.push("the expected export is missing from the plugin's configuration");
    else if (proxy.length !== 1) {
      problems.push(`expected exactly one proxy_network export, found ${proxy.length}`);
    } else {
      const entry = asRecord(proxy[0]);
      if (!entry) problems.push("proxy_network is not a table");
      else {
        if (!samePrefix(entry.cidr, expect.proxy.cidr)) {
          problems.push(`proxy_network cidr is ${String(entry.cidr)}, expected ${expect.proxy.cidr}`);
        }
        if (!samePrefix(entry.mapped_cidr, expect.proxy.mappedCidr)) {
          problems.push(`proxy_network mapped_cidr is ${String(entry.mapped_cidr)}, expected ${expect.proxy.mappedCidr}`);
        }
      }
    }
  } else if (proxy.length > 0) {
    problems.push(`a node that is not sharing must not export a network, found ${proxy.length} proxy_network entr(ies)`);
  }

  // --- ACL -------------------------------------------------------------------
  const acl = asRecord(root.acl);
  const v1 = acl ? asRecord(acl.acl_v1) : null;
  if (!v1) return { ok: problems.length === 0, problems: [...problems, "acl.acl_v1 is missing: EasyTier would allow everything"] };
  const rawChains = asArray(v1.chains);
  if (rawChains.length === 0) return { ok: false, problems: [...problems, "there are no ACL chains"] };
  const chains: Chain[] = [];
  for (const [i, c] of rawChains.entries()) {
    const rec = asRecord(c);
    if (!rec) {
      problems.push(`chain ${i + 1} is not a table`);
      continue;
    }
    chains.push(rec as Chain);
    if (rec.chain_type !== CHAIN_INBOUND && rec.chain_type !== CHAIN_OUTBOUND && rec.chain_type !== CHAIN_FORWARD) {
      problems.push(`chain ${i + 1} (${String(rec.name)}) has an unknown chain_type ${String(rec.chain_type)}`);
    }
  }

  // Inbound: every Inbound chain, enabled or not, must be a closed drop-all, and
  // at least one must be enabled (otherwise EasyTier's inbound default is Allow).
  const inbound = chains.filter((c) => c.chain_type === CHAIN_INBOUND);
  if (inbound.length === 0) problems.push("no Inbound chain: EasyTier's default inbound action is Allow");
  const inboundEnabled = firstEnabled(chains, CHAIN_INBOUND);
  if (!inboundEnabled) problems.push("no enabled Inbound chain");
  for (const c of inbound) {
    if (c.default_action !== ACTION_DROP) problems.push(`Inbound chain ${String(c.name)} does not default to Drop`);
    if (asArray(c.rules).length > 0) {
      problems.push(`Inbound chain ${String(c.name)} has ${asArray(c.rules).length} rule(s); it must have none`);
    }
  }

  // Forward: only the published TCP ports may be allowed, and the default must
  // be Drop on every enabled Forward chain.
  const forward = chains.filter((c) => c.chain_type === CHAIN_FORWARD);
  const allowed = new Set<number>();
  for (const c of forward) {
    if (c.enabled !== false && c.default_action !== ACTION_DROP) {
      problems.push(`Forward chain ${String(c.name)} does not default to Drop`);
    }
    for (const r of asArray(c.rules)) {
      const rule = asRecord(r) as Rule | null;
      if (!rule) {
        problems.push(`a rule of Forward chain ${String(c.name)} is not a table`);
        continue;
      }
      if (rule.enabled === false) continue;
      if (rule.action !== ACTION_ALLOW) // Drop/Noop rules only ever restrict
        continue;
      if (rule.protocol !== PROTO_TCP) {
        problems.push(`Forward chain ${String(c.name)} allows a non-TCP protocol`);
        continue;
      }
      if (asArray(rule.source_ips).length || asArray(rule.destination_ips).length || asArray(rule.source_ports).length) {
        problems.push(`Forward chain ${String(c.name)} has an address-scoped allow rule; only plain port rules are expected`);
      }
      const ports = portList(rule.ports);
      if (!ports || ports.length === 0) {
        problems.push(`Forward chain ${String(c.name)} has an allow rule without explicit ports`);
        continue;
      }
      for (const p of ports) allowed.add(p);
    }
  }
  if (exporting) {
    const want = [...new Set(expect.publishedPorts)].sort((a, b) => a - b);
    if (want.length > 0 && forward.length === 0) problems.push("an exporting node needs a Forward chain for its published ports");
    const got = [...allowed].sort((a, b) => a - b);
    if (want.length > 0 && JSON.stringify(want) !== JSON.stringify(got)) {
      problems.push(`the Forward chain allows [${got.join(", ")}], expected exactly [${want.join(", ")}]`);
    } else if (want.length === 0 && got.length > 0) {
      problems.push(`this node publishes no forwarded port, but the Forward chain allows [${got.join(", ")}]`);
    }
  } else if (allowed.size > 0) {
    problems.push(`a node that is not sharing must not allow any forwarded port, found [${[...allowed].join(", ")}]`);
  }

  // --- loopback forwards -----------------------------------------------------
  // A port forward binds a listener on this machine. It must be loopback-only:
  // a forward bound to a LAN address would publish somebody's local service to
  // the whole network. The forwards this plugin asked for must all be present.
  const forwards = asArray(root.port_forward);
  const seen = new Set<string>();
  for (const [i, f] of forwards.entries()) {
    const rec = asRecord(f);
    if (!rec) {
      problems.push(`port_forward ${i + 1} is not a table`);
      continue;
    }
    const bind = String(rec.bind_addr ?? "");
    const dst = String(rec.dst_addr ?? "");
    const host = bind.replace(/^tcp:\/\//, "").split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") {
      problems.push(`port_forward ${i + 1} is bound to ${bind || "(nothing)"}; a local forward must be loopback-only`);
    }
    if (rec.proto !== undefined && String(rec.proto).toLowerCase() !== "tcp") {
      problems.push(`port_forward ${i + 1} is not TCP`);
    }
    seen.add(`${bind}->${dst}`);
  }
  for (const want of expect.portForwards) {
    if (!seen.has(`${want.bindAddr}->${want.dstAddr}`)) {
      problems.push(`the config does not forward ${want.bindAddr} -> ${want.dstAddr}`);
    }
  }
  if (!expect.portForwards.length && forwards.length > 0) {
    problems.push(`this node consumes nothing but its config has ${forwards.length} port forward(s)`);
  }

  return { ok: problems.length === 0, problems };
}
