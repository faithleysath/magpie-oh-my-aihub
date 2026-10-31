// In-memory port binder for unit tests: no socket is created on the host.
//
// `busy` simulates a listener owned by somebody else, so a test can prove that
// allocation skips it and that a claim which cannot be proven is reported as a
// conflict instead of being used.

import type { PortBinder, PortReservation } from "../../src/ports.ts";

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
