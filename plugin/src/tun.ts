// Whether this process can give EasyTier a TUN device.
//
// A device is not a performance detail here. A packet that arrives through a TUN
// device carries the **peer's own overlay address** as its source, so Magpie sees
// a real client and enforces the Gateway Key and its cost limit. Through the
// user-space (no-TUN) stack EasyTier instead delivers an inbound connection to
// `127.0.0.1`, which Magpie answers as the local, keyless caller — so a no-TUN
// node can serve no metered gateway, and `renderOverlayConfig` keeps 3425 closed
// for it.
//
// Root (or CAP_NET_ADMIN, which this probe does not try to read) plus whatever
// the platform needs: Linux needs `/dev/net/tun`, macOS needs root for utun.
// `OH_MY_AIHUB_TUN` overrides the probe for tests and for a host it misreads.

import { existsSync } from "node:fs";

export const TUN_ENV = "OH_MY_AIHUB_TUN";

/** How a node joins the overlay: with a device, or entirely in user space. */
export type OverlayMode = "tun" | "no-tun";

export interface TunProbe {
  platform?: NodeJS.Platform;
  uid?: number | null;
  exists?: (path: string) => boolean;
  env?: string | undefined;
}

export function canCreateTun(probe: TunProbe = {}): boolean {
  const platform = probe.platform ?? process.platform;
  const uid = probe.uid === undefined ? (process.getuid?.() ?? null) : probe.uid;
  const exists = probe.exists ?? existsSync;
  const raw = (probe.env === undefined ? process.env[TUN_ENV] : probe.env) ?? "";
  const override = raw.trim().toLowerCase();
  if (override === "1" || override === "true" || override === "yes") return true;
  if (override === "0" || override === "false" || override === "no") return false;
  if (uid !== 0) return false;
  if (platform === "linux") return exists("/dev/net/tun");
  return platform === "darwin" || platform === "win32";
}

/**
 * The mode a start will use. Asking for a device without the ability to create
 * one falls back to user space rather than failing: the node still joins, it
 * just cannot be a metered provider.
 */
export function effectiveMode(requested: boolean, capability?: boolean): OverlayMode {
  return requested && (capability ?? canCreateTun()) ? "tun" : "no-tun";
}
