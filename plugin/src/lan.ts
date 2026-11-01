// The LAN address this node exports through EasyTier (`[[proxy_network]]`).
//
// EasyTier's export is addressed by a local address, so the address must be the
// interface a peer can actually reach after the overlay: a real LAN interface,
// never `0.0.0.0`, never loopback, never a link-local or CGNAT/VPN range. The
// caller probes once per start (or per join, which is a deliberate redo) and
// keeps the result for the life of that core.
//
// `OH_MY_AIHUB_LAN_IP` overrides the probe. It exists for isolated tests that
// must publish on 127.0.0.1 (a loopback value is accepted there even though the
// real probe refuses it) and for a host whose LAN address the probe misreads.

import { networkInterfaces } from "node:os";

export const LAN_IP_ENV = "OH_MY_AIHUB_LAN_IP";

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.trim().split(".").map(Number);
  if (parts.length !== 4) return null;
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

export function isIPv4(value: string): boolean {
  return ipv4Parts(value) !== null;
}

function isLoopback(ip: string): boolean {
  return ip.startsWith("127.");
}

function isPrivate(ip: string): boolean {
  const parts = ipv4Parts(ip);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Ranges that are not a "usable LAN address" for an overlay export. */
function isUnusable(ip: string): boolean {
  const parts = ipv4Parts(ip);
  if (!parts) return true;
  const [a, b] = parts;
  if (a === 0 || a === 127 || a >= 224) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark / proxy TUN
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (VPN)
  return false;
}

const PREFERRED_INTERFACE = /^(en0|en1|eth0|eth1|ens\d+|enp\d+|wlan\d+|Wi-?Fi)$/;

/**
 * The first usable LAN IPv4, preferring private ranges and ordinary interface
 * names. Returns null when the machine only has loopback (a laptop with Wi-Fi
 * off): the plugin then publishes nothing and says so in `status`.
 */
export function detectLanIPv4(): string | null {
  const override = (process.env[LAN_IP_ENV] ?? "").trim();
  if (override) {
    if (!isIPv4(override)) throw new Error(`${LAN_IP_ENV} is not an IPv4 address: ${override}`);
    return override;
  }

  const candidates: { name: string; ip: string; private: boolean; preferred: boolean }[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (isUnusable(addr.address) || isLoopback(addr.address)) continue;
      candidates.push({
        name,
        ip: addr.address,
        private: isPrivate(addr.address),
        preferred: PREFERRED_INTERFACE.test(name),
      });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.private !== b.private) return a.private ? -1 : 1;
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.ip.localeCompare(b.ip);
  });
  return candidates[0].ip;
}
