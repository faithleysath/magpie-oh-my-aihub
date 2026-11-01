#!/usr/bin/env bun
/**
 * Preload for CI test subsets: refuse to touch the developer's real Magpie
 * gateway (:3425) or any non-loopback host. Loopback HTTP/TCP is allowed so
 * fixture servers and the runtime smoke test can run.
 *
 * This guards the process, not the code under test: if a test really tries to
 * reach the network it fails loudly instead of silently reading local state.
 */
const realFetch = globalThis.fetch;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function blocked(reason: string, input: unknown): never {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: string } | null)?.url;
  throw new Error(`offline-guard: ${reason} (${String(raw).slice(0, 200)})`);
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  let url: URL;
  try {
    url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  } catch {
    return blocked("refused a request without a parseable URL", input);
  }
  if (url.protocol === "data:" || url.protocol === "file:") return realFetch(input, init);
  if (url.port === "3425") return blocked("the real Magpie gateway :3425 is blocked in CI", input);
  if (!LOOPBACK_HOSTS.has(url.hostname)) return blocked(`non-loopback host ${url.hostname} is blocked`, input);
  return realFetch(input, init);
}) as typeof fetch;
