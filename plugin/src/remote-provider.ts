// The Remote Magpie entries this plugin owns in the user's Magpie.
//
// Magpie stores a provider as an id plus the URLs it is reached at. A
// `remote-magpie` this plugin created is identified by both: the id it derives
// from the peer's wallet and the loopback forward it allocated. The id alone is
// not proof of ownership — a user can create a provider by hand with the same
// id — so every remove/replace checks the URL as well.

import type { ProviderRecord } from "./magpie.ts";

export const PROVIDER_PREFIX = "omai-";

/** `omai-<last 8 hex>`: the id Magpie lists this peer under. */
export function remoteProviderId(provider: string): string {
  return `${PROVIDER_PREFIX}${provider.toLowerCase().replace(/^0x/, "").slice(-8)}`;
}

/**
 * The URL roots Magpie stores for a Remote Magpie. Magpie normalises the
 * provider it was given (`chat` becomes `<root>/v1`, `anthropic` stays `<root>`),
 * so the comparison strips the suffixes rather than trusting one field.
 */
export function remoteProviderRoots(record: ProviderRecord): string[] {
  const roots: string[] = [];
  for (const value of [record.chat, record.responses, record.anthropic]) {
    if (typeof value !== "string" || !value) continue;
    roots.push(value.trim().replace(/\/+$/, "").replace(/\/v1$/, ""));
  }
  return roots;
}

/** Whether `record` is the Remote Magpie this plugin made for `localPort`. */
export function isOurRemoteProvider(record: ProviderRecord, id: string, localPort: number): boolean {
  if (record.id !== id || record.preset !== "remote-magpie") return false;
  return remoteProviderRoots(record).includes(`http://127.0.0.1:${localPort}`);
}
