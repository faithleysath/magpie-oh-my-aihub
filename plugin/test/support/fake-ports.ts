// In-memory port binder for unit tests: no socket is created on the host.
//
// `busy` simulates a listener owned by somebody else, so a test can prove that
// allocation skips it and that a claim which cannot be proven is reported as a
// conflict instead of being used.

import type { PortBinder, PortReservation, SocketOwnership, SocketOwnershipProbe } from "../../src/ports.ts";

export class FakeBinder implements PortBinder {
  held = new Set<string>();
  busy = new Set<string>();

  static key(host: string, port: number): string {
    return `${host}:${port}`;
  }

  async reserve(host: string, port: number): Promise<PortReservation | null> {
    const key = FakeBinder.key(host, port);
    if (this.held.has(key) || this.busy.has(key)) return null;
    this.held.add(key);
    return {
      host,
      port,
      release: async () => {
        this.held.delete(key);
      },
    };
  }

  async isFree(host: string, port: number): Promise<boolean> {
    const key = FakeBinder.key(host, port);
    return !this.held.has(key) && !this.busy.has(key);
  }

  occupy(host: string, port: number): void {
    this.busy.add(FakeBinder.key(host, port));
  }

  free(host: string, port: number): void {
    this.busy.delete(FakeBinder.key(host, port));
  }
}

/**
 * Test seam for the OS socket-owner probe. Production uses lsof/ss; a test maps
 * a port to the PID that should own it (or marks the probe unavailable).
 */
export class FakeOwnership implements SocketOwnershipProbe {
  supported = true;
  /** port -> listening PIDs; an unmapped port uses `defaultPids` */
  pids = new Map<number, number[]>();
  /** PIDs returned for an unmapped port; empty means "nothing listens" */
  defaultPids: number[] = [];

  async listenerPids(port: number): Promise<SocketOwnership> {
    if (!this.supported) {
      return { supported: false, pids: [], detail: "test: no socket-owner probe on this platform" };
    }
    return { supported: true, pids: [...(this.pids.get(port) ?? this.defaultPids)], detail: null };
  }
}
