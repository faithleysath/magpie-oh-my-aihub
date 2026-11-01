// A log subscription, so a new deposit does not have to be found by sweeping.
//
// `eth_getLogs` is the scarce resource on public endpoints: one refuses ranges
// over 25 blocks, another answers 429, and a node that has fallen behind spends
// hours bisecting. A subscription inverts that — the provider pushes exactly the
// transfers that name our address, and the watcher only asks for the blocks it
// was told about. Measured 2026-11-02: BSC pushed 112 USDC transfers in 25
// seconds, Base 1317.
//
// This is an accelerator, never a dependency. The 15-second sweep keeps running
// whether or not a socket ever opens, so a provider without `eth_subscribe` (or a
// socket that stops coming back) costs latency, not correctness.

import { TRANSFER_TOPIC } from "./chain.ts";

export interface LogTailOptions {
  /** `wss://` endpoint, already derived from the chain's HTTP endpoint */
  url: string;
  /** the token contract to watch (the chain's USDC) */
  address: string;
  /** the 32-byte topic form of this node's address: `0x` + 24 zeros + the address */
  toTopic: string;
  /** a block that holds a transfer to us; it may not be final yet */
  onBlock: (block: number) => void;
}

export interface LogTailStatus {
  connected: boolean;
  detail: string | null;
  received: number;
  lastBlock: number | null;
  url: string;
}

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/** The `wss` form of an `http(s)` endpoint, or null when it cannot be one. */
export function wsUrlFor(httpUrl: string): string | null {
  try {
    const url = new URL(httpUrl);
    if (url.protocol === "wss:" || url.protocol === "ws:") return url.toString();
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  } catch {
    return null;
  }
}

export class LogTail {
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = false;
  private connected = false;
  private detail: string | null = null;
  private received = 0;
  private lastBlock: number | null = null;

  constructor(private readonly opts: LogTailOptions) {}

  status(): LogTailStatus {
    return {
      connected: this.connected,
      detail: this.detail,
      received: this.received,
      lastBlock: this.lastBlock,
      url: this.opts.url,
    };
  }

  start(): void {
    if (this.stopped || this.socket) return;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      /* already gone */
    }
  }

  private fail(detail: string): void {
    this.connected = false;
    this.detail = detail;
  }

  private connect(): void {
    if (this.stopped) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.opts.url);
    } catch (error) {
      // A malformed URL never fixes itself; keep the reason for `status`.
      this.fail(`cannot open ${this.opts.url}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      try {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_subscribe",
            params: ["logs", { address: this.opts.address, topics: [TRANSFER_TOPIC, null, this.opts.toTopic] }],
          }),
        );
      } catch (error) {
        this.fail(`subscribe send failed: ${error instanceof Error ? error.message : String(error)}`);
        this.closeAndRetry();
      }
    };

    socket.onmessage = (event) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (payload.id === 1) {
        const error = payload.error as { message?: string } | undefined;
        if (error) {
          // The provider refuses this subscription; stop asking it forever.
          this.fail(`subscribe refused: ${error.message ?? "unknown reason"}`);
          this.socket = null;
          this.stopped = true;
          try {
            socket.close();
          } catch {
            /* already gone */
          }
          return;
        }
        this.attempts = 0;
        this.connected = true;
        this.detail = null;
        return;
      }
      if (payload.method !== "eth_subscription") return;
      const result = (payload.params as { result?: { blockNumber?: unknown } } | undefined)?.result;
      const raw = typeof result?.blockNumber === "string" ? result.blockNumber : "";
      const block = Number.parseInt(raw, 16);
      if (!Number.isFinite(block)) return;
      this.received += 1;
      this.lastBlock = block;
      try {
        this.opts.onBlock(block);
      } catch {
        /* the watcher's own callback must not kill the socket */
      }
    };

    socket.onerror = () => {
      this.fail("socket error");
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      if (this.stopped) return;
      this.fail(this.detail ?? "socket closed");
      this.scheduleRetry();
    };
  }

  private closeAndRetry(): void {
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      /* already gone */
    }
    if (!this.stopped) this.scheduleRetry();
  }

  /** Exponential backoff with a little jitter: 1s, 2s, 4s … capped at 30s. */
  private scheduleRetry(): void {
    if (this.stopped || this.retry) return;
    const base = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(this.attempts, 5));
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.attempts += 1;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, delay);
    this.retry.unref?.();
  }
}
