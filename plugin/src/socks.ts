// One HTTP request through EasyTier's own SOCKS5 listener.
//
// This is the on-demand path for reading a peer's directory: it creates no
// EasyTier port forward and no listener of its own, so a discovery read cannot
// leak a port that EasyTier 2.6.4 cannot close. The proxy is bound to
// 127.0.0.1 by the generated TOML (`socks5_proxy`), which is the only way to get
// a loopback listening socket: `--socks5` hardcodes 0.0.0.0.
//
// The implementation is the one that was proven in the previous catalogue
// client (src/catalog.ts), copied here so the new code does not import the old,
// deprecated module.

import { connect, type Socket } from "node:net";

export const SOCKS_MAX_BYTES = 64 * 1024;

export interface SocksHttpOptions {
  /** the local EasyTier SOCKS5 listener port (fixed 13400 in this product) */
  socksPort: number;
  /** an IPv4 address on the overlay; the SOCKS5 path is IPv4 only */
  host: string;
  port: number;
  path: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** POST is needed for `POST /request`; GET is the default */
  method?: "GET" | "POST";
  /** JSON body for a POST; ignored for GET */
  body?: string;
}

export type SocksHttpGetOptions = SocksHttpOptions;

function ipv4Bytes(host: string): Buffer {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`the SOCKS5 client only dials IPv4 addresses, not ${host}`);
  }
  return Buffer.from(parts);
}

/** Reads exact protocol fields from a socket without losing coalesced bytes. */
class SocketReader {
  private buf = Buffer.alloc(0);
  constructor(private it: AsyncIterator<Buffer>) {}

  async read(n: number, what: string): Promise<Buffer> {
    while (this.buf.length < n) {
      const { value, done } = await this.it.next();
      if (done || !value) throw new Error(`SOCKS5 peer closed while reading ${what}`);
      this.buf = this.buf.length ? Buffer.concat([this.buf, value]) : Buffer.from(value);
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async rest(max: number): Promise<Buffer> {
    const parts: Buffer[] = this.buf.length ? [this.buf] : [];
    let total = this.buf.length;
    for (;;) {
      const { value, done } = await this.it.next();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > max) throw new Error(`directory response exceeds ${max} bytes`);
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
  }
}

export async function socksHttpGet(opts: SocksHttpGetOptions): Promise<{ status: number; body: string }> {
  return socksHttpRequest(opts);
}

/** One request through the overlay's SOCKS5 listener; the connection is closed. */
export async function socksHttpRequest(opts: SocksHttpOptions): Promise<{ status: number; body: string }> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const method = opts.method ?? "GET";
  const payload = method === "POST" ? (opts.body ?? "") : "";
  const maxBytes = opts.maxBytes ?? SOCKS_MAX_BYTES;
  const host = ipv4Bytes(opts.host);
  const port = Buffer.from([(opts.port >> 8) & 255, opts.port & 255]);
  const socket: Socket = connect({ host: "127.0.0.1", port: opts.socksPort });
  socket.setNoDelay(true);
  const timer = setTimeout(() => socket.destroy(new Error(`directory read timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.removeAllListeners("error");
    const it = (socket as unknown as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
    const reader = new SocketReader(it);

    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    const hello = await reader.read(2, "the SOCKS5 greeting");
    if (hello[0] !== 0x05 || hello[1] !== 0x00) throw new Error("the EasyTier SOCKS5 listener refused no-auth");

    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), host, port]));
    const replyHead = await reader.read(4, "the SOCKS5 connect reply");
    if (replyHead[0] !== 0x05 || replyHead[1] !== 0x00) {
      throw new Error(`SOCKS5 connect failed with code ${replyHead[1]}`);
    }
    const atyp = replyHead[3];
    const addrLen =
      atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (await reader.read(1, "the SOCKS5 name length"))[0] : 0;
    if (!addrLen) throw new Error("SOCKS5 connect reply has an unknown address type");
    await reader.read(addrLen + 2, "the SOCKS5 bound address");

    const req =
      `${method} ${opts.path} HTTP/1.1\r\n` +
      `Host: ${opts.host}:${opts.port}\r\n` +
      `Accept: application/json\r\n` +
      (method === "POST"
        ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n`
        : "") +
      `User-Agent: omai-catalog/1\r\n` +
      `Connection: close\r\n\r\n` +
      payload;
    socket.write(req);

    const chunks = await reader.rest(maxBytes + 8192);
    const raw = chunks.toString("utf8");
    const split = raw.indexOf("\r\n\r\n");
    if (split < 0) throw new Error("the peer answered without an HTTP header");
    const header = raw.slice(0, split).split("\r\n");
    const status = Number(/^HTTP\/1\.[01]\s+(\d{3})/.exec(header[0] ?? "")?.[1] ?? 0);
    const body = raw.slice(split + 4);
    if (Buffer.byteLength(body) > maxBytes) throw new Error(`the peer's response exceeds ${maxBytes} bytes`);
    return { status, body };
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
