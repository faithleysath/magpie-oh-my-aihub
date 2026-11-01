// Preloaded into the child CLI processes spawned by test/phase8-cli.test.ts.
//
// It records every outbound `fetch` to HERMETIC_CHILD_LOG and refuses anything
// whose exact origin is not listed in HERMETIC_CHILD_ALLOW. A leaked probe
// therefore cannot reach the developer's real Magpie gateway, the LAN or a
// public RPC endpoint, and the attempt is still visible to the test (a
// "BLOCKED" line) instead of silently succeeding.
//
// Scope: only `globalThis.fetch` inside this child process. Raw `node:http`/
// `node:net` sockets, another runtime's fetch binding and other processes are
// outside this spy; the parent test preload (network-guard.ts) is a separate,
// equally scoped guard for the test process.

import { appendFileSync } from "node:fs";

const log = process.env.HERMETIC_CHILD_LOG ?? "";
const allowed = new Set(
  (process.env.HERMETIC_CHILD_ALLOW ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const realFetch = globalThis.fetch.bind(globalThis);

function record(line: string): void {
  if (log) appendFileSync(log, `${line}\n`);
}

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  let url = "";
  try {
    url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String((input as { url?: unknown } | null)?.url ?? input);
    const origin = new URL(url).origin;
    if (allowed.has(origin)) {
      record(`ALLOW ${url}`);
      return realFetch(input as RequestInfo, init);
    }
    record(`BLOCKED ${url}`);
    throw new TypeError(`child network spy: ${origin} is not an allowed test origin`);
  } catch (error) {
    if (error instanceof TypeError && String(error.message).startsWith("child network spy:")) throw error;
    record(`BLOCKED ${url || String(input)}`);
    throw new TypeError("child network spy: unparseable fetch target");
  }
}) as typeof fetch;
