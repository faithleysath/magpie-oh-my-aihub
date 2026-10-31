// Assembly runtime: control listener + signed presence + consumer pull/poll.
//
// This is the bridge between the reviewed B core/adapter and the existing
// Service. It intentionally exposes only narrow local actions; no remote payload
// can name an action, endpoint, file, port or Magpie admin operation.

import { randomBytes, randomUUID } from "node:crypto";
import { lanIPv4, statePath } from "../paths.ts";
import { logger } from "../log.ts";
import {
  loadOrCreateCatalogIdentity,
  socksHttpGet,
  type CatalogIdentity,
} from "../catalog.ts";
import { mappedHost } from "../addresses.ts";
import { catalogPriceVersion } from "../pricing.ts";
import { claimFreePort, OsSocketOwnership, portRange, SocketBinder, verifyOwnedPort } from "../ports.ts";
import { catalogQuoteUsability, type Service } from "../service.ts";
import { startControlServer, type ControlServerHandle } from "./http.ts";
import { createP2pBusinessPort } from "./p2p-port.ts";
import { PRESENCE_PATH, signPresence, verifyPresence, type PresenceBody } from "./presence.ts";
import { loadPresenceTrust, presenceTofu, savePresenceTrust, type PresencePin, type PresenceTofu } from "./presence-trust.ts";
import {
  P2pNode,
  type P2pApprovalView,
  type P2pPeerIdentity,
  type P2pRequestDocument,
  type P2pRequestView,
} from "../p2p/index.ts";
import { p2pIdentityFromCatalog, type P2pLocalBinding } from "../p2p/identity.ts";
import { P2pStore } from "../p2p/store.ts";
import type { P2pHelloTarget } from "../p2p/handshake.ts";
import type { P2pTransport } from "../p2p/node.ts";

interface Endpoint {
  host: string;
  port: number;
  /** Host header the provider's listener expects (mapped address for overlay forwards). */
  hostHeader?: string;
  mappedCidr: string | null;
  expiresAt?: string;
  quoteHash: string | null;
  fingerprint: string;
}

export interface ControlAppOptions {
  host?: string;
  port?: number;
  endpoints?: Record<string, Endpoint>;
  tickMs?: number;
  now?: () => Date;
  /** tests only: allow a direct LAN/loopback presence endpoint without an ET forward */
  allowLanDirect?: boolean;
  /** injected read for presence probes; production uses the overlay SOCKS5 path */
  presenceHttpGet?: (input: { socksPort: number; host: string; port: number; path: string; timeoutMs: number }) => Promise<{ status: number; body: string }>;
}

export interface ControlActionInput {
  nodeId?: unknown;
  fingerprint?: unknown;
  quoteHash?: unknown;
  models?: unknown;
  requestId?: unknown;
  capUsd?: unknown;
  acceptFingerprint?: unknown;
  note?: unknown;
  approvalId?: unknown;
  generation?: unknown;
  consumerFingerprint?: unknown;
  priceVersion?: unknown;
}

function text(value: unknown, name: string, max = 300): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be non-empty text`);
  }
  return value.trim();
}

function modelsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) throw new Error("models must be a non-empty list");
  const models = value.map((m) => text(m, "model", 200));
  if (new Set(models).size !== models.length) throw new Error("models must be distinct");
  return models;
}

function capOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.0001 || value > 1_000_000) {
    throw new Error("capUsd must be a positive amount on the $0.0001 grid");
  }
  if (Math.abs(Math.round(value * 1e4) / 1e4 - value) > 1e-9) throw new Error("capUsd must be on the $0.0001 grid");
  return value;
}

function fetchJson(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "error",
    signal: signal ?? AbortSignal.timeout(10_000),
  }).then(async (res) => {
    const textBody = await res.text();
    if (!res.ok) throw new Error(`control endpoint HTTP ${res.status}`);
    if (textBody.length > 1024 * 1024) throw new Error("control response too large");
    return JSON.parse(textBody) as unknown;
  });
}

/** HTTP transport with an explicit peer->endpoint map supplied by presence. */
export function createHttpTransport(endpoints: Map<string, Endpoint>): P2pTransport {
  const endpointOf = (peer: P2pPeerIdentity | P2pHelloTarget): Endpoint => {
    const ep = endpoints.get(peer.nodeId);
    if (!ep) throw new Error(`no ready control endpoint for ${peer.nodeId}`);
    return ep;
  };
  const hostHeader = (ep: Endpoint) => ep.hostHeader ?? `${ep.host}:${ep.port}`;
  return {
    async hello(target, hello) {
      const ep = endpointOf(target);
      return fetchJson(`http://${ep.host}:${ep.port}/p2p/v1/hello`, hello, { host: hostHeader(ep) });
    },
    canPush(peer) {
      return endpoints.has(peer.nodeId);
    },
    async frame(session, frame) {
      const ep = endpointOf(session.peer);
      const res = await fetch(`http://${ep.host}:${ep.port}/p2p/v1/frame?session=${session.sessionId}`, {
        method: "POST",
        headers: { host: hostHeader(ep), "content-type": "application/octet-stream" },
        body: new Uint8Array(frame),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status !== 204) throw new Error(`control frame HTTP ${res.status}`);
    },
    async poll(target, hello) {
      const ep = endpointOf(target);
      const result = await fetchJson(`http://${ep.host}:${ep.port}/p2p/v1/poll`, hello, { host: hostHeader(ep) });
      const o = result as { serverHello?: unknown; frames?: unknown };
      if (!o || !Array.isArray(o.frames)) throw new Error("poll response is invalid");
      return { serverHello: o.serverHello, frames: o.frames.map(String) };
    },
  };
}

let active: ControlApp | null = null;
const byService = new WeakMap<Service, ControlApp>();

export function controlAppFor(service: Service): ControlApp | null {
  return byService.get(service) ?? (active ?? null);
}

export class ControlApp {
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly peers = new Map<string, P2pHelloTarget>();
  private readonly targets = new Set<string>();
  private readonly seenPresence = new Map<string, PresenceBody>();
  /** how each seen presence's key relates to the local TOFU pin */
  private readonly presenceTofu = new Map<string, PresenceTofu>();
  /** bounded probe bookkeeping for control-only neighbours (no catalogue) */
  private readonly presenceProbed = new Map<string, { at: number; port: number | null; detail: string | null }>();
  private readonly controlForwards = new Map<string, { localPort: number; dst: string }>();
  private readonly retiredForwards = new Map<number, string>();
  private publishedHost = "127.0.0.1";
  private allowedHosts: string[] = [];
  private stopped = false;
  private readonly allowLanDirect: boolean;
  private constructor(
    readonly service: Service,
    readonly node: P2pNode,
    readonly identity: CatalogIdentity,
    readonly server: ControlServerHandle,
    readonly host: string,
    readonly port: number,
    private readonly now: () => Date,
    private readonly tickMs: number,
    allowLanDirect = false,
    private readonly presenceHttpGet: NonNullable<ControlAppOptions["presenceHttpGet"]> = socksHttpGet,
  ) {
    this.allowLanDirect = allowLanDirect;
  }

  static async start(service: Service, options: ControlAppOptions = {}): Promise<ControlApp | null> {
    const cfg = service.config();
    if (!cfg?.nodeId || !cfg.controlEnabled) return null;
    const host = (options.host ?? lanIPv4() ?? "127.0.0.1").trim();
    // The port is persisted before the core starts (service.ensureControlPort)
    // so the Forward ACL can name it without an extra restart. A caller may
    // still pass an explicit test port.
    let port = options.port ?? cfg.controlPort ?? null;
    if (!port) {
      const claim = await claimFreePort(new SocketBinder(), host, portRange(35000, 35099));
      port = claim.reservation.port;
      await claim.reservation.release();
      service.setControlPort(port);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("control port allocation failed");
    const identity = loadOrCreateCatalogIdentity();
    const quote = service.catalogStatus().quote;
    const binding: P2pLocalBinding = {
      nodeId: cfg.nodeId,
      hostname: `ohmyaihub-${cfg.nodeId}`,
      mappedCidr: cfg.mappedCidr,
      controlPort: port,
      gatewayPort: service.gatewayPort(),
      catalogQuoteHash: quote?.contentHash ?? null,
    };
    const p2pIdentity = p2pIdentityFromCatalog(identity, binding);
    const store = new P2pStore(statePath("p2p.sqlite"));
    const app = new ControlApp(
      service,
      null as unknown as P2pNode,
      identity,
      null as unknown as ControlServerHandle,
      host,
      port,
      options.now ?? (() => new Date()),
      options.tickMs ?? 4000,
      options.allowLanDirect ?? false,
      options.presenceHttpGet,
    );
    const transport = createHttpTransport(app.endpoints);
    const node = new P2pNode({
      identity: p2pIdentity,
      store,
      port: createP2pBusinessPort(service),
      transport,
      now: app.now,
    });
    (app as { node: P2pNode }).node = node;
    // The allowed Host values must follow a later topology change: a node that
    // starts unshared is only bound to its own LAN host, and enabling sharing
    // creates the mapped export afterwards. Passing a snapshot here made the
    // live listener keep rejecting the mapped Host with 403 until a restart.
    app.allowedHosts = app.allowedHostsFor(cfg, host, port);
    const server = startControlServer({
      host,
      port,
      listener: host === "127.0.0.1" || host === "localhost" || host === "::1" ? "loopback-only" : "lan-reachable",
      allowedHosts: () => app.allowedHosts,
      node: {
        acceptHello: (hello) => node.acceptHello(hello).then((r) => r.serverHello),
        handleFrame: (sessionId, frame) => node.handleFrame(sessionId, frame),
        acceptPoll: async (hello) => {
          const r = await node.acceptHello(hello, { rejectReplay: true });
          const frames = await node.pullFrames(r.sessionId);
          return { serverHello: r.serverHello, frames: frames.map((f) => f.toString("base64")) };
        },
      },
      now: () => app.now().getTime(),
    });
    (app as { server: ControlServerHandle }).server = server;
    service.setControlActive(true);
    try {
      // Publish the control listener through the existing no-TUN export/Forward
      // ACL. Sharing nodes add this one port to their published set; a node
      // that shares no models exports only presence + control, never the
      // Magpie gateway. Inbound stays Drop with zero rules either way.
      await service.applyControlPublication();
    } catch (error) {
      service.setControlActive(false);
      server.stop();
      service.setControlPresence(null);
      node.close();
      throw error;
    }
    app.publishPresence();
    app.ticker = setInterval(() => {
      void app.pollTick();
    }, app.tickMs);
    app.ticker.unref?.();
    byService.set(service, app);
    active = app;
    return app;
  }

  /**
   * Re-applies the control plane after a topology change (configure, sharing
   * on/off). The publication set, the exported address and the presence-only
   * listener all follow the current config; nothing here creates a key or
   * changes an authorization.
   */
  /** Keep an authenticated peer in the bounded poll set (payment relies on pull). */
  watchPeer(nodeId: string): void {
    if (typeof nodeId === "string" && nodeId.length > 0 && nodeId.length <= 128) this.targets.add(nodeId);
  }

  private allowedHostsFor(cfg: { mappedCidr: string | null } | null, host: string, port: number): string[] {
    const list = [`${host}:${port}`];
    if (cfg?.mappedCidr) list.push(`${mappedHost(cfg.mappedCidr)}:${port}`);
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") list.push(`localhost:${port}`);
    return [...new Set(list)];
  }

  async sync(): Promise<void> {
    if (this.stopped) return;
    const cfg = this.service.config();
    if (!cfg?.controlEnabled) {
      this.service.setControlActive(false);
      await this.service.applyControlPublication().catch(() => {});
      return;
    }
    const sharing = cfg.sharingEnabled && cfg.mappedCidr;
    this.publishedHost = sharing ? mappedHost(cfg.mappedCidr!) : this.host;
    // Enabling sharing creates the mapped export; the control listener must
    // accept that exact mapped Host. Without this a consumer reaches the
    // forward with the mapped Host and the provider answers 403.
    this.allowedHosts = this.allowedHostsFor(cfg, this.host, this.port);
    // The B handshake binds the hello to this node's published catalogue quote.
    // A node that starts unshared has null there; sharing afterwards changes
    // the quote, and every client hello would be refused as a quote mismatch
    // until the whole host restarted. Keep the binding on the live node.
    const quote = this.service.catalogStatus().quote;
    this.node.setBinding({
      nodeId: cfg.nodeId,
      hostname: `ohmyaihub-${cfg.nodeId}`,
      mappedCidr: cfg.mappedCidr,
      controlPort: this.port,
      gatewayPort: this.service.gatewayPort(),
      catalogQuoteHash: quote?.contentHash ?? null,
    });
    await this.service.applyControlPublication();
    this.publishPresence();
  }

  private presenceBody(): PresenceBody {
    const cfg = this.service.config()!;
    const now = this.now();
    return {
      schema: "ohmyaihub.presence/v1",
      node: {
        nodeId: cfg.nodeId,
        hostname: `ohmyaihub-${cfg.nodeId}`,
        fingerprint: this.identity.summary.fingerprint,
        publicKey: this.identity.summary.publicKey,
      },
      // The endpoint host must be the address the peer can actually dial. When
      // an export exists that is the mapped address (the verifier requires it
      // to equal mappedCidr); a direct LAN endpoint is only for an unexported
      // test fixture.
      endpoint: { host: cfg.mappedCidr ? mappedHost(cfg.mappedCidr) : this.publishedHost, mappedCidr: cfg.mappedCidr, controlPort: this.port, ready: true },
      capability: { control: true, sharing: cfg.sharingEnabled ? "enabled" : "disabled", providesModels: Boolean(cfg.sharingEnabled) },
      issuedAt: new Date(now.getTime() - 10_000).toISOString(),
      expiresAt: new Date(now.getTime() + 120_000).toISOString(),
    };
  }

  publishPresence(): void {
    this.service.setControlPresence(() => signPresence(this.presenceBody(), this.identity));
  }

  private async dropForward(nodeId: string): Promise<void> {
    const forward = this.controlForwards.get(nodeId);
    if (!forward) return;
    this.controlForwards.delete(nodeId);
    const retire = (this.service as { retireControlForward?: (bind: string, dst: string, owned?: string[]) => Promise<{ closed: boolean; detail?: string | null }> }).retireControlForward;
    const owned = [...this.controlForwards.values()].map((f) => `127.0.0.1:${f.localPort}`).concat([...this.retiredForwards.keys()].map((p) => `127.0.0.1:${p}`));
    if (typeof retire === "function") {
      const result = await retire.call(this.service, `127.0.0.1:${forward.localPort}`, forward.dst, owned);
      if (!result.closed || result.detail) {
        this.retiredForwards.set(forward.localPort, forward.dst);
        for (const other of this.controlForwards.values()) this.retiredForwards.set(other.localPort, other.dst);
        this.controlForwards.clear();
        this.endpoints.clear();
        this.peers.clear();
      }
      return;
    }
    await this.service.supervisor.removePortForward(`127.0.0.1:${forward.localPort}`).catch(() => {});
    try {
      if (!(await new SocketBinder().isFree("127.0.0.1", forward.localPort))) this.retiredForwards.set(forward.localPort, forward.dst);
    } catch {
      this.retiredForwards.set(forward.localPort, forward.dst);
    }
  }

  registerPeer(nodeId: string, endpoint: Endpoint, target?: P2pHelloTarget): void {
    if (!/^[a-f0-9]{8,64}$/.test(nodeId)) throw new Error("invalid peer node id");
    this.endpoints.set(nodeId, { ...endpoint });
    if (target) this.peers.set(nodeId, target);
  }

  /** Fetch + verify a peer's signed presence and remember its exact control endpoint. */
  async discover(nodeId: string): Promise<Endpoint> {
    const cfg = this.service.config();
    const peer = this.service.catalogStatus().peers.find((p) => p.nodeId === nodeId);
    if (!cfg || !peer || !peer.mappedCidr || !peer.catalogPort) throw new Error(`no signed catalogue entry for ${nodeId}`);
    if (!peer.identity?.fingerprint || !peer.quoteHash) throw new Error(`peer ${nodeId} has no accepted identity/quote`);
    const existing = this.endpoints.get(nodeId);
    const stale =
      !existing ||
      peer.status === "identity-changed" ||
      existing.fingerprint !== peer.identity.fingerprint ||
      !existing.expiresAt ||
      Date.parse(existing.expiresAt) - this.now().getTime() <= 60_000;
    if (!stale) return existing!;
    const res = await socksHttpGet({
      socksPort: cfg.catalog.socksPort,
      host: mappedHost(peer.mappedCidr),
      port: peer.catalogPort,
      path: PRESENCE_PATH,
      timeoutMs: 5000,
    });
    if (res.status !== 200) throw new Error(`presence HTTP ${res.status}`);
    const presence = verifyPresence(JSON.parse(res.body), this.now(), { expectedMappedCidr: peer.mappedCidr });
    if (presence.node.nodeId !== peer.nodeId || presence.node.fingerprint !== peer.identity.fingerprint) {
      throw new Error("presence identity differs from the signed catalogue identity");
    }
    let endpoint: Endpoint;
    const mapped = presence.endpoint.mappedCidr ?? peer.mappedCidr;
    if (mapped) {
      // A presence refresh near the TTL is not an endpoint change. The Forward
      // is a static loopback->overlay mapping; recreating it on every refresh
      // forced a supervised core restart every ~64 s (EasyTier 2.6.4 cannot
      // close a live forward). Reuse it while the signed address, control port
      // and identity are unchanged, and only refresh the evidence timestamps.
      const sameForward =
        existing &&
        existing.mappedCidr === mapped &&
        existing.fingerprint === presence.node.fingerprint &&
        existing.hostHeader === `${mappedHost(mapped)}:${presence.endpoint.controlPort}`;
      if (sameForward) {
        const refreshed: Endpoint = {
          ...existing!,
          quoteHash: peer.quoteHash,
          fingerprint: presence.node.fingerprint,
          expiresAt: presence.expiresAt,
        };
        this.endpoints.set(nodeId, refreshed);
        this.seenPresence.set(presence.node.nodeId, presence);
        this.applyPresenceCapability(presence);
        this.registerPeer(presence.node.nodeId, refreshed, {
          accountId: presence.node.fingerprint,
          nodeId: presence.node.nodeId,
          fingerprint: presence.node.fingerprint,
          mappedCidr: presence.endpoint.mappedCidr,
          controlPort: presence.endpoint.controlPort,
          catalogQuoteHash: peer.quoteHash,
        });
        return refreshed;
      }
      if (existing) {
        await this.dropForward(nodeId);
        this.endpoints.delete(nodeId);
      }
      // The signed endpoint is the mapped overlay address. Use the existing
      // EasyTier Forward path to a local owner-proven loopback port; never fall
      // back to a LAN address in production.
      const claim = await claimFreePort(new SocketBinder(), "127.0.0.1", portRange(35100, 35199));
      const localPort = claim.reservation.port;
      await claim.reservation.release();
      const dst = `${mappedHost(mapped)}:${presence.endpoint.controlPort}`;
      // Registered through the Service so it joins the canonical Forward set:
      // a forward the supervisor does not expect is an unsafe runtime state.
      const addControlForward = (this.service as { addControlForward?: (bind: string, dst: string) => Promise<boolean> }).addControlForward;
      const added = typeof addControlForward === "function"
        ? await addControlForward.call(this.service, `127.0.0.1:${localPort}`, dst)
        : await this.service.supervisor.addPortForward(`127.0.0.1:${localPort}`, dst);
      if (!added && !this.service.supervisor.listPortForwards) {
        throw new Error("the overlay control forward could not be installed");
      }
      const corePid = this.service.supervisor.snapshot().pid;
      const proof = await verifyOwnedPort({
        ownership: new OsSocketOwnership(),
        purpose: "control",
        host: "127.0.0.1",
        port: localPort,
        owner: "easytier",
        reported: true,
        expectedPids: corePid ? [corePid] : [],
        now: this.now,
      });
      if (proof.state !== "stable") {
        await this.service.supervisor.removePortForward(`127.0.0.1:${localPort}`).catch(() => {});
        throw new Error(`the overlay control forward is not owner-proven: ${proof.state}`);
      }
      this.controlForwards.set(presence.node.nodeId, { localPort, dst });
      endpoint = {
        host: "127.0.0.1",
        port: localPort,
        hostHeader: `${mappedHost(mapped)}:${presence.endpoint.controlPort}`,
        mappedCidr: mapped,
        quoteHash: peer.quoteHash,
        fingerprint: presence.node.fingerprint,
        expiresAt: presence.expiresAt,
      };
    } else if (this.allowLanDirect) {
      if (existing) {
        await this.dropForward(nodeId);
        this.endpoints.delete(nodeId);
      }
      endpoint = {
        host: presence.endpoint.host,
        port: presence.endpoint.controlPort,
        mappedCidr: null,
        quoteHash: peer.quoteHash,
        fingerprint: presence.node.fingerprint,
        expiresAt: presence.expiresAt,
      };
    } else {
      throw new Error("the provider published no mapped endpoint; LAN fallback is disabled");
    }
    this.seenPresence.set(presence.node.nodeId, presence);
    this.applyPresenceCapability(presence);
    this.registerPeer(presence.node.nodeId, endpoint, {
      accountId: presence.node.fingerprint,
      nodeId: presence.node.nodeId,
      fingerprint: presence.node.fingerprint,
      mappedCidr: presence.endpoint.mappedCidr,
      controlPort: presence.endpoint.controlPort,
      catalogQuoteHash: peer.quoteHash,
    });
    return endpoint;
  }

  private targetOf(nodeId: string): P2pHelloTarget {
    const target = this.peers.get(nodeId);
    if (!target) throw new Error("peer presence is not registered");
    return target;
  }

  /**
   * Ensure a live control session to a peer exists. C payment outbound uses the
   * same authenticated session path as a request: a queued frame must not sit in
   * the outbox merely because the last poll session closed.
   */
  async ensureSession(nodeId: string, options: { force?: boolean } = {}): Promise<void> {
    const peer = this.service.catalogStatus().peers.find((p) => p.nodeId === nodeId);
    if (!peer?.mappedCidr) throw new Error(`no signed catalogue entry for ${nodeId}`);
    let target: P2pHelloTarget | null = null;
    try { target = this.targetOf(nodeId); } catch { /* no presence endpoint yet */ }
    if (!options.force && target && this.node.hasLiveSession({ nodeId: target.nodeId, fingerprint: target.fingerprint })) return;
    await this.discover(nodeId);
    target = this.targetOf(nodeId);
    if (!options.force && this.node.hasLiveSession({ nodeId: target.nodeId, fingerprint: target.fingerprint })) return;
    await this.node.openSession(target);
  }

  async request(input: ControlActionInput): Promise<{ requestId: string; state: "pending" }> {
    const nodeId = text(input.nodeId, "nodeId", 64);
    const models = modelsOf(input.models);
    const fingerprint = text(input.fingerprint, "fingerprint", 64);
    const quoteHash = text(input.quoteHash, "quoteHash", 64);
    const peer = this.service.catalogStatus().peers.find((p) => p.nodeId === nodeId);
    if (!peer?.quote || !peer.mappedCidr || !peer.quoteHash) throw new Error("provider catalogue is not available");
    // A withdrawn catalogue or an expired quote is not an offer, even if the
    // signed presence still says the peer is online.
    const usability = catalogQuoteUsability(peer);
    if (!usability.usable) throw new Error(`provider ${usability.detail}`);
    if (peer.identity?.fingerprint !== fingerprint || peer.quoteHash !== quoteHash) throw new Error("the accepted fingerprint/quote is not current");
    if (peer.status !== "verified" && peer.status !== "connected") throw new Error("provider identity is not accepted");
    const available = peer.quote.models.map((m) => m.id);
    if (models.some((m) => !available.includes(m))) throw new Error("a requested model is not in the current quote");
    const priceVersion = catalogPriceVersion(peer.quote.models.filter((m) => models.includes(m.id)));
    if (!priceVersion) throw new Error("the selected models have no complete price");
    await this.discover(nodeId);
    const target = this.targetOf(nodeId);
    const session = await this.node.openSession(target);
    const request: P2pRequestDocument = {
      // A new human request gets a new identity; the outbox retry reuses this
      // exact document, so retries stay idempotent while an expired request can
      // be asked again.
      nonce: randomBytes(8).toString("hex"),
      consumer: { nodeId: this.service.config()!.nodeId, hostname: `ohmyaihub-${this.service.config()!.nodeId}` },
      provider: {
        nodeId,
        hostname: peer.hostname,
        mappedCidr: peer.mappedCidr,
        gatewayPort: peer.quote.node.gatewayPort,
        catalogPort: peer.quote.node.catalogPort,
      },
      models,
      quote: { contentHash: peer.quoteHash, priceVersion, identityFingerprint: fingerprint, priceLocked: false },
      acceptance: { fingerprint, quoteHash, priceVersion },
    };
    const result = await this.node.requestConnection({ sessionId: session.sessionId, request });
    this.targets.add(nodeId);
    return { requestId: result.requestHash, state: "pending" };
  }

  /** Read-only selected-model quote preview; no key, no approval, no trust change. */
  async quotePreview(input: ControlActionInput): Promise<Record<string, unknown>> {
    const requestHash = text(input.requestId, "requestId", 64);
    const models = modelsOf(input.models);
    const request = (await this.node.listRequests()).find((r) => r.requestHash === requestHash);
    if (!request) throw new Error("request not found");
    if (models.some((m) => !request.models.includes(m))) throw new Error("preview models must be a subset of the request");
    const quote = this.service.catalogStatus().quote;
    if (!quote || quote.contentHash !== request.quoteHash) throw new Error("the request quote is stale");
    const selected = quote.models.filter((m) => models.includes(m.id));
    const priceVersion = catalogPriceVersion(selected);
    if (!priceVersion) throw new Error("the selected models have no complete price");
    return {
      requestId: requestHash,
      quoteHash: quote.contentHash,
      priceVersion,
      models,
      pricing: selected.map((m) => ({ id: m.id, pricing: m.pricing })),
    };
  }

  async approve(input: ControlActionInput): Promise<P2pApprovalView> {
    const requestHash = text(input.requestId, "requestId", 64);
    if (!Object.prototype.hasOwnProperty.call(input, "generation")) throw new Error("generation is required");
    const models = modelsOf(input.models);
    const capUsd = capOf(input.capUsd);
    const request = (await this.node.listRequests()).find((r) => r.requestHash === requestHash);
    if (!request) throw new Error("request not found");
    const fingerprint = text(input.consumerFingerprint, "consumerFingerprint", 64);
    const quoteHash = text(input.quoteHash, "quoteHash", 64);
    const priceVersion = text(input.priceVersion, "priceVersion", 64);
    if (fingerprint !== request.consumer.fingerprint || quoteHash !== request.quoteHash) throw new Error("request identity/quote is stale");
    if (models.some((m) => !request.models.includes(m))) throw new Error("approved models must be a subset of the request");
    const quote = this.service.catalogStatus().quote;
    const selectedVersion = quote ? catalogPriceVersion(quote.models.filter((m) => models.includes(m.id))) : null;
    if (!quote || quote.contentHash !== request.quoteHash || !selectedVersion || priceVersion !== selectedVersion) {
      throw new Error("selected price version is stale");
    }
    const activeApproval = request.approvalId ? await this.node.approvalView(request.approvalId) : null;
    const currentGeneration = activeApproval?.generation ?? null;
    if (input.generation !== currentGeneration) throw new Error("request generation is stale");
    let acceptConsumer = false;
    if (request.trust !== "accepted") {
      const expected = text(input.acceptFingerprint, "acceptFingerprint", 64);
      if (expected !== request.consumer.fingerprint) throw new Error("accepted fingerprint does not match the request");
      acceptConsumer = true;
    } else if (input.acceptFingerprint !== undefined && text(input.acceptFingerprint, "acceptFingerprint", 64) !== request.consumer.fingerprint) {
      throw new Error("accepted fingerprint does not match the request");
    }
    const approval = await this.node.approve(requestHash, { models, capUsd, acceptConsumer, memo: input.note === undefined ? null : text(input.note, "note", 200) });
    this.targets.add(request.consumer.nodeId);
    await this.node.tick();
    return approval;
  }

  async reject(input: ControlActionInput): Promise<void> {
    await this.node.reject(text(input.requestId, "requestId", 64), "declined", input.note === undefined ? undefined : text(input.note, "note", 200));
  }

  async revoke(input: ControlActionInput): Promise<void> {
    await this.node.revoke(text(input.approvalId, "approvalId", 32), "operator-revoked");
  }

  async recover(input: ControlActionInput): Promise<{ state: string; detail: string | null }> {
    const approvalId = input.approvalId === undefined ? null : text(input.approvalId, "approvalId", 32);
    const result = await this.node.tick();
    return { state: approvalId ? "recovering" : "ok", detail: `${result.failed} retryable, ${result.actionNeeded.length} action-needed` };
  }

  private async pollTick(): Promise<void> {
    // A published provider's signed presence is the prerequisite for a
    // zero-file request; discover it (and its owned control forward) before the
    // user can click. Bounded: two peers per tick, never a model request.
    await this.refreshSeenPresences().catch(() => {});
    await this.discoverCataloguedPresence().catch(() => {});
    await this.probeControlOnlyNeighbours().catch(() => {});
    for (const nodeId of this.targets) {
      try {
        const cached = this.endpoints.get(nodeId);
        const peer = this.service.catalogStatus().peers.find((p) => p.nodeId === nodeId);
        const changed =
          !cached ||
          !peer ||
          !peer.identity?.fingerprint ||
          peer.identity.fingerprint !== cached.fingerprint ||
          peer.mappedCidr !== cached.mappedCidr ||
          peer.quoteHash !== cached.quoteHash ||
          peer.status === "identity-changed";
        if (changed || !cached.expiresAt || Date.parse(cached.expiresAt) - this.now().getTime() <= 60_000) {
          await this.discover(nodeId);
        }
        const target = this.peers.get(nodeId);
        if (!target) continue;
        await this.node.poll(target);
      } catch (error) {
        // The next bounded tick retries; no action is created from a poll error.
        logger.warn(`control poll to ${nodeId} failed: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
      }
    }
    try {
      await this.node.tick();
    } catch {
      /* surfaced by status/action-needed, never retried as a new write here */
    }
  }

  private async discoverCataloguedPresence(): Promise<void> {
    const peers = this.service.catalogStatus().peers.filter(
      (p) => p.online === true && Boolean(p.quote) && Boolean(p.nodeId) && !this.endpoints.has(p.nodeId!),
    );
    let budget = 2;
    for (const peer of peers) {
      if (budget <= 0) break;
      budget -= 1;
      try {
        await this.discover(peer.nodeId!);
      } catch {
        // Bounded retry on the next tick; a missing presence only disables the
        // zero-file path, never the catalogue display.
      }
    }
  }

  /**
   * A configured node that shares no models still publishes a signed presence
   * on its catalogue port (control-only publication). Its catalogue is empty,
   * so it never appears as a model offer; this probe only discovers that the
   * node exists, is reachable and what it is willing to accept. Bounded: one
   * probe per peer per 10 s, at most 2 new probes per tick, and never a model
   * request.
   */
  private async probeControlOnlyNeighbours(): Promise<void> {
    const cfg = this.service.config();
    if (!cfg) return;
    const peers = this.service.catalogStatus().peers;
    let budget = 2;
    for (const peer of peers) {
      if (budget <= 0) break;
      if (peer.status === "self" || peer.status === "conflict") continue;
      if (!peer.mappedCidr || peer.online !== true) continue;
      if (peer.quote) continue; // a published catalogue has its own discovery path
      if (this.seenPresence.has(peer.nodeId ?? "")) continue;
      const key = peer.hostname;
      const last = this.presenceProbed.get(key);
      const now = this.now().getTime();
      if (last && now - last.at < 10_000) continue;
      budget -= 1;
      this.presenceProbed.set(key, { at: now, port: null, detail: null });
      try {
        await this.probePresence(peer.mappedCidr, cfg.catalog.port);
        this.presenceProbed.set(key, { at: now, port: this.presenceProbed.get(key)?.port ?? null, detail: null });
      } catch (error) {
        this.presenceProbed.set(key, { at: now, port: null, detail: String((error as Error)?.message ?? error).slice(0, 200) });
      }
    }
  }

  /**
   * Reads and verifies a peer's signed presence from its mapped address. The
   * signature, the node id/hostname binding and the mapped address are checked
   * before anything is remembered; the key is pinned on first sight and a
   * change is reported, never accepted.
   */
  async probePresence(mappedCidr: string, basePort: number): Promise<PresenceBody> {
    const cfg = this.service.config();
    if (!cfg) throw new Error("configure this node first");
    let lastDetail = "no presence answer";
    // Same bounded compatibility window as the catalogue read, widened by two
    // lower ports: two isolated lab nodes share one host and cannot bind the
    // same port, and a node's presence port is its own configured catalogue
    // port. Every candidate is one HTTP GET; no port sweep.
    const candidates = [basePort, ...[1, 2, 3, 4].map((d) => basePort + d), basePort - 1, basePort - 2]
      .filter((p) => p >= 1 && p <= 65535);
    for (const port of [...new Set(candidates)]) {
      let res: { status: number; body: string };
      try {
        res = await this.presenceHttpGet({
          socksPort: cfg.catalog.socksPort,
          host: mappedHost(mappedCidr),
          port,
          path: PRESENCE_PATH,
          timeoutMs: 4000,
        });
      } catch (e) {
        lastDetail = `no signed presence through the overlay: ${(e as Error).message}`;
        continue;
      }
      if (res.status !== 200) {
        lastDetail = `presence HTTP ${res.status} on port ${port}`;
        continue;
      }
      let presence: PresenceBody;
      try {
        presence = verifyPresence(JSON.parse(res.body), this.now(), { expectedMappedCidr: mappedCidr });
      } catch (e) {
        lastDetail = `invalid presence: ${(e as Error).message}`;
        continue;
      }
      const pins = loadPresenceTrust();
      const existing = pins[presence.node.nodeId];
      const state = presenceTofu(existing, presence.node.fingerprint);
      const now = this.now().toISOString();
      if (!existing) {
        pins[presence.node.nodeId] = {
          nodeId: presence.node.nodeId,
          fingerprint: presence.node.fingerprint,
          publicKey: presence.node.publicKey,
          firstSeenAt: now,
          lastSeenAt: now,
          accepted: false,
          pending: null,
        };
      } else if (existing.fingerprint !== presence.node.fingerprint) {
        existing.pending = { fingerprint: presence.node.fingerprint, publicKey: presence.node.publicKey, seenAt: now };
        existing.lastSeenAt = now;
      } else {
        existing.lastSeenAt = now;
      }
      savePresenceTrust(pins);
      this.seenPresence.set(presence.node.nodeId, presence);
      this.applyPresenceCapability(presence);
      this.presenceTofu.set(presence.node.nodeId, state);
      this.presenceProbed.set(presence.node.hostname, { at: this.now().getTime(), port, detail: null });
      return presence;
    }
    throw new Error(lastDetail);
  }

  /**
   * A presence that says "no models" is the authoritative withdrawal signal for
   * the display catalogue; the catalogue server itself may still answer 503.
   */
  private applyPresenceCapability(presence: PresenceBody): void {
    const sharing = presence.capability.sharing === "enabled" && presence.capability.providesModels === true;
    if (sharing) return;
    const svc = this.service as unknown as { markCatalogWithdrawn?: (nodeId: string, detail?: string, hostname?: string) => void };
    svc.markCatalogWithdrawn?.(presence.node.nodeId, "the provider's signed presence says it is not sharing models", presence.node.hostname);
  }

  /**
   * Re-read a presence near its half-life without touching the owned forward:
   * this only keeps the announced capability (and therefore the catalogue
   * withdrawal) current. An endpoint change is handled by discover() on the
   * next request/poll, which retires the forward safely.
   */
  async refreshPresence(nodeId: string): Promise<void> {
    const cfg = this.service.config();
    const peer = this.service.catalogStatus().peers.find((p) => p.nodeId === nodeId);
    if (!cfg || !peer?.mappedCidr) return;
    const base = peer.catalogPort ?? cfg.catalog.port;
    let res: { status: number; body: string } | null = null;
    for (const port of [base, ...[1, 2, 3, 4].map((d) => base + d), base - 1, base - 2].filter((p) => p >= 1 && p <= 65535).slice(0, 7)) {
      const attempt = await this.presenceHttpGet({
        socksPort: cfg.catalog.socksPort,
        host: mappedHost(peer.mappedCidr),
        port,
        path: PRESENCE_PATH,
        timeoutMs: 4000,
      }).catch(() => null);
      if (attempt?.status === 200) { res = attempt; break; }
    }
    if (!res) return;
    const presence = verifyPresence(JSON.parse(res.body), this.now(), { expectedMappedCidr: peer.mappedCidr });
    if (presence.node.nodeId !== peer.nodeId) return;
    if (peer.identity?.fingerprint && presence.node.fingerprint !== peer.identity.fingerprint) return;
    this.seenPresence.set(presence.node.nodeId, presence);
    this.applyPresenceCapability(presence);
  }

  private async refreshSeenPresences(): Promise<void> {
    const now = this.now().getTime();
    let budget = 2;
    for (const presence of [...this.seenPresence.values()]) {
      if (budget <= 0) break;
      const exp = Date.parse(presence.expiresAt);
      if (!Number.isFinite(exp) || exp - now > 90_000) continue;
      budget -= 1;
      await this.refreshPresence(presence.node.nodeId).catch(() => {});
    }
  }

  /** Human acceptance of a control-only peer's full fingerprint (TOFU). */
  trustPresence(nodeId: string, fingerprint: string): { nodeId: string; fingerprint: string; accepted: true } {
    if (!/^[a-f0-9]{8,64}$/.test(nodeId)) throw new Error("invalid node id");
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error("the exact 64-hex fingerprint is required");
    const pins = loadPresenceTrust();
    const pin: PresencePin | undefined = Object.hasOwn(pins, nodeId) ? pins[nodeId] : undefined;
    if (!pin) throw new Error(`no signed presence from ${nodeId} has been read yet`);
    const pendingMatches = pin.pending?.fingerprint === fingerprint;
    if (!pendingMatches && pin.fingerprint !== fingerprint) {
      throw new Error(`the observed fingerprint of ${nodeId} is ${pin.pending?.fingerprint ?? pin.fingerprint}, not ${fingerprint}`);
    }
    if (!pendingMatches && pin.fingerprint === fingerprint && pin.pending) {
      // Re-accepting the key that is already trusted does not confirm the new
      // key; the change warning stays until the new fingerprint is accepted.
      return { nodeId, fingerprint, accepted: true };
    }
    pins[nodeId] = {
      ...pin,
      fingerprint,
      publicKey: pendingMatches ? pin.pending!.publicKey : pin.publicKey,
      accepted: true,
      pending: null,
      lastSeenAt: this.now().toISOString(),
    };
    savePresenceTrust(pins);
    const seen = this.seenPresence.get(nodeId);
    if (seen && seen.node.fingerprint === fingerprint) this.presenceTofu.set(nodeId, "accepted");
    return { nodeId, fingerprint, accepted: true };
  }

  async state(): Promise<Record<string, unknown>> {
    const requests = await this.node.listRequests();
    const approvals = await this.node.listApprovals();
    const outbound = requests.filter((r) => r.consumer.nodeId === this.service.config()?.nodeId);
    const inbound = requests.filter((r) => r.consumer.nodeId !== this.service.config()?.nodeId);
    return {
      schema: "ohmyaihub/p2p-state/1",
      enabled: true,
      pollTargets: [...this.targets],
      endpoints: [...this.endpoints.keys()],
      listener: {
        state: "ready",
        host: this.host,
        port: this.port,
        reachability: this.host === "127.0.0.1" || this.host === "localhost" ? "loopback" : "lan",
        verified: true,
        detail: this.retiredForwards.size
          ? `${this.retiredForwards.size} stale control forward(s) require a supervised core restart`
          : null,
      },
      inboundRequests: inbound.map((r) => ({
        requestId: r.requestHash,
        consumerNodeId: r.consumer.nodeId,
        consumerHostname: r.consumer.hostname || null,
        consumerFingerprint: r.consumer.fingerprint,
        models: r.models,
        quoteHash: r.quoteHash,
        priceVersion: r.priceVersion,
        generation: approvals.find((a) => a.approvalId === r.approvalId)?.generation ?? null,
        capUsd: null,
        expiresAt: r.expiresAt,
        tofu: r.trust,
        state: r.approvalState ?? r.state,
        receivedAt: r.receivedAt,
        detail: r.note,
      })),
      outboundRequests: outbound.map((r) => ({
        requestId: r.requestHash,
        providerNodeId: approvals.find((a) => a.requestHash === r.requestHash)?.provider.nodeId ?? "",
        providerHostname: null,
        providerFingerprint: approvals.find((a) => a.requestHash === r.requestHash)?.provider.fingerprint ?? "",
        models: r.models,
        quoteHash: r.quoteHash,
        priceVersion: r.priceVersion,
        state: r.approvalState ?? r.state,
        ack: null,
        createdAt: r.receivedAt,
        updatedAt: r.receivedAt,
        detail: r.note,
      })),
      approvals: approvals.map((a) => ({
        approvalId: a.approvalId,
        requestId: a.requestHash,
        consumerNodeId: a.consumer.nodeId,
        consumerFingerprint: a.consumer.fingerprint,
        providerNodeId: a.provider.nodeId,
        providerFingerprint: a.provider.fingerprint,
        models: a.models,
        capUsd: a.capUsd,
        quoteHash: a.quoteHash,
        priceVersion: a.priceVersion,
        generation: a.generation,
        keyId: a.keyId,
        state: a.state,
        delivery: { state: a.deliveredAt ? "delivered" : "queued", lastError: a.error },
        createdAt: a.createdAt,
        approvedAt: a.approvedAt,
        expiresAt: a.expiresAt,
        detail: a.error,
      })),
      connections: this.service.providers().map((p) => ({
        providerNodeId: p.id,
        providerHostname: p.fingerprint?.hostname ?? null,
        providerId: p.id,
        state: p.status === "connected" ? "connected" : "action-needed",
        models: p.limit ? [] : [],
        capUsd: null,
        readbackAt: p.lastConnectedAt,
        detail: p.detail,
      })),
      presence: [...this.seenPresence.values()].map((p) => {
        const catalogPeer = this.service.catalogStatus().peers.find((x) => x.nodeId === p.node.nodeId);
        const probed = this.presenceProbed.get(p.node.hostname);
        // A control-only peer has no catalogue entry; its TOFU state comes from
        // the persisted presence pin. A catalogue identity, when present, is
        // stricter and wins.
        const tofu =
          catalogPeer?.status === "verified" || catalogPeer?.status === "connected" ? "accepted"
          : catalogPeer?.status === "identity-changed" ? "changed"
          : this.presenceTofu.get(p.node.nodeId) ?? (catalogPeer ? "pending" : "unknown");
        return {
          nodeId: p.node.nodeId,
          hostname: p.node.hostname,
          fingerprint: p.node.fingerprint,
          endpoint: { host: p.endpoint.host, mappedCidr: p.endpoint.mappedCidr, controlPort: p.endpoint.controlPort },
          capability: p.capability,
          expiresAt: p.expiresAt,
          signature: "valid",
          tofu,
          verified: true,
          catalogQuoteHash: catalogPeer?.quoteHash ?? null,
          presencePort: probed?.port ?? null,
        };
      }),
      counts: {
        pendingInbound: inbound.filter((r) => r.approvalState === null || r.approvalState === "approving").length,
        awaitingApproval: inbound.filter((r) => r.state === "awaiting-approval" || r.state === "awaiting-trust").length,
        connected: this.service.providers().filter((p) => p.status === "connected").length,
        actionNeeded: approvals.filter((a) => a.actionNeeded !== null).length,
      },
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.service.setControlPresence(null);
    this.server.stop();
    const forwards = [...this.controlForwards.values()];
    const retired = [...this.retiredForwards.entries()];
    const owned = [...forwards.map((f) => `127.0.0.1:${f.localPort}`), ...retired.map(([p]) => `127.0.0.1:${p}`)];
    let degraded: string | null = null;
    const retire = (this.service as { retireControlForward?: (bind: string, dst: string, owned?: string[]) => Promise<{ closed: boolean }> }).retireControlForward;
    for (const forward of forwards) {
      if (typeof retire === "function") {
        const result = await retire.call(this.service, `127.0.0.1:${forward.localPort}`, forward.dst, owned).catch(() => ({ closed: false }));
        if (!result.closed) degraded = "a control forward is still listening after stop";
      } else {
        await this.service.supervisor.removePortForward(`127.0.0.1:${forward.localPort}`).catch(() => {});
        try {
          if (!(await new SocketBinder().isFree("127.0.0.1", forward.localPort))) degraded = "a control forward is still listening after stop";
        } catch {
          degraded = "a control forward could not be probed after stop";
        }
      }
    }
    for (const [localPort, dst] of retired) {
      if (typeof retire === "function") {
        const result = await retire.call(this.service, `127.0.0.1:${localPort}`, dst, owned).catch(() => ({ closed: false }));
        if (!result.closed) degraded = "a retired control forward is still listening after stop";
      } else {
        await this.service.supervisor.removePortForward(`127.0.0.1:${localPort}`).catch(() => {});
      }
    }
    this.node.close();
    this.service.setControlActive(false);
    try {
      // Withdraw the control-only export / control port. Model sharing, keys
      // and the catalogue are untouched: this only removes the P2P endpoint.
      await this.service.applyControlPublication();
    } catch (error) {
      degraded = `control publication withdrawal failed: ${String((error as Error)?.message ?? error)}`;
    }
    // Clear the in-memory ownership first: a degraded stop still releases this
    // instance, so a retry starts from a clean app rather than a half-dead one.
    this.controlForwards.clear();
    this.retiredForwards.clear();
    active = null;
    byService.delete(this.service);
    this.stopped = true;
    if (degraded) throw new Error(degraded);
  }
}

export function startControlApp(service: Service, options: ControlAppOptions = {}): Promise<ControlApp | null> {
  return ControlApp.start(service, options);
}
