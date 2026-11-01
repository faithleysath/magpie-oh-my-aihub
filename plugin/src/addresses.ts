// Addresses that must be unique across the overlay.
//
// Kept separately from the supervisor so state migration can allocate a mapped
// prefix without importing the supervisor (and without a cycle).

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
