// Addresses that must be unique across the overlay.
//
// Kept separately from the supervisor so state migration can allocate a mapped
// prefix without importing the supervisor (and without a cycle).

/**
 * A random, persisted virtual address inside the fixed overlay /24.
 */
export function randomVirtualIp(overlayCidr: string, taken: Set<number> = new Set()): string {
  const base = overlayCidr.replace(/\.0\/24$/, "");
  for (let i = 0; i < 200; i++) {
    const host = 2 + Math.floor(Math.random() * 252);
    if (!taken.has(host)) return `${base}.${host}/24`;
  }
  throw new Error("no free overlay address");
}

/**
 * A unique, persisted per-provider overlay prefix (10.66.a.b/32). Two providers
 * exporting the same LAN subnet are only addressable apart because of this.
 */
export function randomMappedCidr(taken: Set<string> = new Set()): string {
  for (let i = 0; i < 200; i++) {
    const a = 1 + Math.floor(Math.random() * 254);
    const b = 1 + Math.floor(Math.random() * 254);
    const cidr = `10.66.${a}.${b}/32`;
    if (!taken.has(cidr)) return cidr;
  }
  throw new Error("no free mapped CIDR");
}

/** `10.66.1.2/32` and `10.66.1.2` are the same mapped prefix. */
export function mappedHost(cidr: string): string {
  return cidr.trim().replace(/\/32$/, "");
}
