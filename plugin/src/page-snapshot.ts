// The page snapshot: an allowlist projection of the host status.
//
// The plugin page is served by Magpie from the plugin's own folder. In the
// window it is a sandboxed frame; under `magpie web --lan` its files are served
// to anyone who holds the per-run token in the page URL, and on disk the file is
// readable by every local account. It is a status renderer, not a second copy of
// the operator's database: per-consumer money, deposit orders, payer/tx linkage,
// RPC endpoints, local paths and raw logs stay behind the token-protected API and
// the CLI.
//
// `projectPageStatus` is a pure allowlist: new fields added to StatusSnapshot do
// not appear here until they are named below. Free text (errors, details,
// reasons) goes through `maskSensitiveText` (and, from log.ts, the registered
// secret redactor) before it is written.

export const PAGE_SCHEMA = "oh-my-aihub/page/2";

export type Scrub = (text: string) => string;

const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const HASH_RE = /0x[0-9a-fA-F]{64}/g;
const ADDRESS_RE = /0x[0-9a-fA-F]{40}/g;
const PATH_RE = /(?:\/(?:Users|home|private|var|tmp|opt|etc|root)\/[^\s"')]+|[A-Za-z]:\\[^\s"')]+)/g;

/**
 * Masks the four classes that must never ride out in free text:
 * addresses, transaction/digest hashes, URLs (an RPC URL can carry an API key)
 * and absolute paths. Public contract addresses are copied field by field and
 * never pass through here.
 */
export function maskSensitiveText(text: string): string {
  return text
    .replace(URL_RE, "<url>")
    .replace(HASH_RE, "<hash>")
    .replace(ADDRESS_RE, "<address>")
    .replace(PATH_RE, "<path>");
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function obj(value: unknown): Obj {
  return isObj(value) ? value : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function strings(value: unknown): string[] {
  return list(value).filter((v): v is string => typeof v === "string");
}

function numbers(value: unknown): number[] {
  return list(value).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

function text(value: unknown, scrub: Scrub): string | null {
  return typeof value === "string" ? scrub(value) : null;
}

function texts(value: unknown, scrub: Scrub): string[] {
  return strings(value).map(scrub);
}

function catalogConfig(value: unknown, scrub: Scrub): Obj {
  const c = obj(value);
  return {
    enabled: bool(c.enabled) ?? false,
    discoveryEnabled: bool(c.discoveryEnabled) ?? false,
    displayName: text(c.displayName, scrub),
    contact: text(c.contact, scrub),
    port: num(c.port),
    socksPort: num(c.socksPort),
    refreshSec: num(c.refreshSec),
    minTopUpUsd: num(c.minTopUpUsd),
  };
}

function suspension(value: unknown, scrub: Scrub): Obj | null {
  if (!isObj(value)) return null;
  return { at: str(value.at), reason: text(value.reason, scrub) };
}

function pauseView(value: unknown, scrub: Scrub): Obj | null {
  if (!isObj(value)) return null;
  return {
    at: str(value.at),
    reason: text(value.reason, scrub),
    enforced: bool(value.enforced) ?? false,
    enforcement: str(value.enforcement),
  };
}

function consumerView(value: unknown, scrub: Scrub): Obj | null {
  const c = obj(value);
  const consumerId = str(c.consumerId);
  if (!consumerId) return null;
  return {
    consumerId,
    models: strings(c.models),
    revokedAt: str(c.revokedAt),
    spent: bool(c.spent),
    paused: pauseView(c.paused, scrub),
  };
}

function consumerSummary(consumers: Obj[]): Obj {
  const summary = { total: consumers.length, open: 0, paused: 0, spent: 0, revoked: 0 };
  for (const c of consumers) {
    if (c.revokedAt) summary.revoked += 1;
    else if (c.paused) summary.paused += 1;
    else if (c.spent) summary.spent += 1;
    else summary.open += 1;
  }
  return summary;
}

function providerView(value: unknown, scrub: Scrub): Obj {
  const p = obj(value);
  const fp = obj(p.fingerprint);
  // The page may say whether the key is spent, not how much is left: the
  // node's own remote spend is operator accounting, not public page data.
  const limit = isObj(p.limit) ? { spent: bool(p.limit.spent) } : null;
  return {
    id: str(p.id),
    remoteMagpieId: str(p.remoteMagpieId),
    mappedCidr: str(p.mappedCidr),
    providerPort: num(p.providerPort),
    localPort: num(p.localPort),
    status: str(p.status),
    detail: text(p.detail, scrub),
    lastConnectedAt: str(p.lastConnectedAt),
    updatedAt: str(p.updatedAt),
    fingerprint: isObj(p.fingerprint)
      ? { hostname: str(fp.hostname), virtualIpv4: str(fp.virtualIpv4), peerId: str(fp.peerId) }
      : null,
    limit,
  };
}

function priceView(value: unknown): Obj | null {
  if (!isObj(value)) return null;
  const p = value;
  return {
    unit: str(p.unit),
    input: num(p.input),
    output: num(p.output),
    cacheRead: num(p.cacheRead),
    cacheWrite: num(p.cacheWrite),
    cacheWrite1h: num(p.cacheWrite1h),
    tiers: list(p.tiers).map((raw) => {
      const t = obj(raw);
      return {
        above: num(t.above),
        input: num(t.input),
        output: num(t.output),
        cacheRead: num(t.cacheRead),
        cacheWrite: num(t.cacheWrite),
        cacheWrite1h: num(t.cacheWrite1h),
      };
    }),
    source: str(p.source),
  };
}

function modelView(value: unknown, scrub: Scrub): Obj {
  const m = obj(value);
  return {
    id: str(m.id),
    displayName: text(m.displayName, scrub),
    gatewayApis: strings(m.gatewayApis),
    nativeApis: m.nativeApis === null ? null : strings(m.nativeApis),
    contextWindow: num(m.contextWindow),
    maxOutputTokens: num(m.maxOutputTokens),
    images: bool(m.images),
    modalities: isObj(m.modalities)
      ? { input: strings(m.modalities.input), output: strings(m.modalities.output) }
      : null,
    reasoningLevels: m.reasoningLevels === null ? null : strings(m.reasoningLevels),
    pricing: priceView(m.pricing),
    capabilitiesSource: str(m.capabilitiesSource),
  };
}

/**
 * The signed catalogue is published to peers by design, so it is public — but
 * it is still projected, not passed through: the free-text fields an operator
 * could paste a credential or a path into (display names, contact, notes) are
 * scrubbed, and an unknown field cannot ride along.
 */
function quoteView(value: unknown, scrub: Scrub): Obj | null {
  if (!isObj(value)) return null;
  const q = value;
  const node = obj(q.node);
  const pub = obj(q.publication);
  const top = obj(q.topUp);
  const bill = obj(q.billing);
  const id = obj(q.identity);
  const models = list(q.models);
  return {
    // The node's own catalogue status is a flat view (version/modelCount/
    // contentHash); a peer's quote is the signed body (schema/node/publication).
    // Accept both and keep the fields the page renders from either.
    schema: str(q.schema),
    version: num(q.version) ?? num(pub.version),
    updatedAt: str(q.updatedAt) ?? str(pub.updatedAt),
    publishedAt: str(q.publishedAt) ?? str(pub.publishedAt),
    contentHash: str(q.contentHash),
    modelCount: num(q.modelCount) ?? models.length,
    node: isObj(q.node)
      ? {
          id: str(node.id),
          displayName: text(node.displayName, scrub),
          hostname: str(node.hostname),
          virtualIpv4: str(node.virtualIpv4),
          mappedCidr: str(node.mappedCidr),
          gatewayPort: num(node.gatewayPort),
          catalogPort: num(node.catalogPort),
          contact: text(node.contact, scrub),
        }
      : null,
    publication: isObj(q.publication)
      ? {
          status: str(pub.status),
          version: num(pub.version),
          updatedAt: str(pub.updatedAt),
          publishedAt: str(pub.publishedAt),
          note: text(pub.note, scrub),
        }
      : null,
    models: models.map((m) => modelView(m, scrub)),
    topUp: isObj(q.topUp)
      ? { minUsd: num(top.minUsd), simulated: bool(top.simulated), note: text(top.note, scrub) }
      : null,
    billing: isObj(q.billing)
      ? {
          quoteOnly: bool(bill.quoteOnly),
          charged: bool(bill.charged),
          note: text(bill.note, scrub),
          priceVersion: str(bill.priceVersion),
          priceLocked: bool(bill.priceLocked),
        }
      : null,
    identity: isObj(q.identity)
      ? {
          algorithm: str(id.algorithm),
          publicKey: str(id.publicKey),
          fingerprint: str(id.fingerprint),
          keyId: str(id.keyId),
          createdAt: str(id.createdAt),
        }
      : null,
    signature: str(q.signature),
  };
}

function providerSummary(providers: Obj[]): Obj {
  let connected = 0;
  let degraded = 0;
  let spent = 0;
  for (const p of providers) {
    if (p.status === "connected") connected += 1;
    else if (typeof p.status === "string") degraded += 1;
    if (isObj(p.limit) && p.limit.spent === true) spent += 1;
  }
  return { total: providers.length, connected, degraded, spent };
}

function catalogPeerView(value: unknown, scrub: Scrub): Obj {
  const p = obj(value);
  const id = obj(p.identity);
  return {
    hostname: str(p.hostname),
    virtualIpv4: str(p.virtualIpv4),
    mappedCidr: str(p.mappedCidr),
    catalogPort: num(p.catalogPort),
    route: str(p.route),
    latencyMs: str(p.latencyMs) ?? num(p.latencyMs),
    tunnel: str(p.tunnel),
    status: str(p.status),
    detail: text(p.detail, scrub),
    nodeId: str(p.nodeId),
    identity: isObj(p.identity)
      ? {
          algorithm: str(id.algorithm),
          publicKey: str(id.publicKey),
          fingerprint: str(id.fingerprint),
          keyId: str(id.keyId),
          createdAt: str(id.createdAt),
          firstSeenAt: str(id.firstSeenAt),
        }
      : null,
    pendingFingerprint: str(p.pendingFingerprint),
    quote: quoteView(p.quote, scrub),
    quoteHash: str(p.quoteHash),
    fetchedAt: str(p.fetchedAt),
    connectedProviderId: str(p.connectedProviderId),
  };
}

function checkView(value: unknown, scrub: Scrub): Obj {
  const c = obj(value);
  return { name: str(c.name), ok: bool(c.ok) ?? false, detail: text(c.detail, scrub), kind: str(c.kind), at: str(c.at) };
}

function readinessView(value: unknown, scrub: Scrub): Obj {
  const r = obj(value);
  return {
    state: str(r.state),
    checkedAt: str(r.checkedAt),
    ageMs: num(r.ageMs),
    source: str(r.source),
    reasons: texts(r.reasons, scrub),
    providers: list(r.providers).map((p) => {
      const q = obj(p);
      return { id: str(q.id), reachability: str(q.reachability) };
    }),
  };
}

function catalogView(value: unknown, scrub: Scrub): Obj {
  const c = obj(value);
  const server = obj(c.server);
  return {
    publishing: bool(c.publishing) ?? false,
    server: {
      running: bool(server.running) ?? false,
      port: num(server.port),
      address: str(server.address),
      error: text(server.error, scrub),
    },
    quote: quoteView(c.quote, scrub),
    config: catalogConfig(c.config, scrub),
    peers: list(c.peers).map((p) => catalogPeerView(p, scrub)),
    lastRefreshAt: str(c.lastRefreshAt),
    refreshing: bool(c.refreshing) ?? false,
    error: text(c.error, scrub),
  };
}

/**
 * The wallet's page view: chains, assets and **counts**. No intents, events,
 * receiving addresses, RPC endpoints or per-consumer credit. The flattened
 * networks/assets shape is what the page renders; `wallet.registry` and
 * `wallet.chains` are joined here.
 */
function walletView(value: unknown, scrub: Scrub): Obj | null {
  if (value === null || value === undefined) return null;
  if (!isObj(value)) return null;
  const w = value;
  const registry = obj(w.registry);

  const healthByChain = new Map<number, Obj>();
  for (const raw of list(w.chains)) {
    const h = obj(raw);
    const id = num(h.chainId);
    if (id !== null) healthByChain.set(id, h);
  }
  const healthByAsset = new Map<string, Obj>();
  for (const h of healthByChain.values()) {
    for (const raw of list(h.assets)) {
      const a = obj(raw);
      const assetId = str(a.assetId);
      if (assetId) healthByAsset.set(assetId, a);
    }
  }

  const networks = list(registry.networks).map((raw) => {
    const n = obj(raw);
    const chainId = num(n.chainId);
    const h = chainId !== null ? healthByChain.get(chainId) : undefined;
    const finality = obj(n.finality);
    return {
      chainId,
      displayName: str(n.displayName),
      networkType: str(n.networkType),
      enabled: bool(n.enabled) ?? false,
      blockExplorer: str(n.blockExplorer),
      finality: { mode: str(finality.mode), confirmations: num(finality.confirmations) },
      head: h ? num(h.head) : null,
      finalizedBlock: h ? num(h.finalizedBlock) : null,
      cursor: h ? num(h.cursor) : null,
      lagBlocks: h ? num(h.lagBlocks) : null,
      lastScanAt: h ? str(h.lastScanAt) : null,
      lastError: h ? text(h.lastError, scrub) : null,
    };
  });

  const assets = list(registry.assets).map((raw) => {
    const a = obj(raw);
    const h = healthByAsset.get(str(a.assetId) ?? "");
    return {
      assetId: str(a.assetId),
      chainId: num(a.chainId),
      symbol: str(a.symbol),
      name: str(a.name),
      decimals: num(a.decimals),
      contractAddress: str(a.contractAddress),
      enabled: bool(a.enabled) ?? false,
      nanosPerToken: str(a.nanosPerToken),
      priceVersion: str(a.priceVersion),
      onchainDecimals: h ? num(h.onchainDecimals) : null,
    };
  });

  const totalsRaw = obj(w.totals);
  const totals = {
    credited: num(totalsRaw.credited) ?? 0,
    finalized: num(totalsRaw.finalized) ?? 0,
    crediting: num(totalsRaw.crediting) ?? 0,
    pending: num(totalsRaw.pending) ?? 0,
    unclaimed: num(totalsRaw.unclaimed) ?? 0,
    uncertain: num(totalsRaw.uncertain) ?? 0,
    reverted: num(totalsRaw.reverted) ?? 0,
    manualReview: num(totalsRaw.manualReview) ?? 0,
    failed: num(totalsRaw.failed) ?? 0,
    events: num(totalsRaw.events) ?? 0,
  };

  return {
    disabled: bool(w.disabled) ?? networks.length === 0,
    networks,
    assets,
    totals,
  };
}

/**
 * Builds the page's status document. Every key is named here; unknown input
 * keys are dropped. Free text is passed through `scrub`.
 */
export function projectPageStatus(input: unknown, scrub: Scrub = maskSensitiveText): Obj {
  const s = obj(input);
  const p = obj(s.plugin);
  const m = obj(s.magpie);
  const c = obj(s.config);
  const et = obj(s.easytier);
  const a = obj(s.accounting);
  const share = obj(c.share);
  const consumers = list(s.consumers)
    .map((x) => consumerView(x, scrub))
    .filter((x): x is Obj => x !== null);
  const providers = list(s.providers).map((p2) => providerView(p2, scrub));

  return {
    schema: PAGE_SCHEMA,
    generatedAt: str(s.generatedAt),
    plugin: { version: str(p.version), pid: num(p.pid), startedAt: str(p.startedAt), stateVersion: num(p.stateVersion) },
    magpie: { version: str(m.version), gateway: str(m.gateway) },
    config: {
      role: str(c.role),
      sharingEnabled: bool(c.sharingEnabled) ?? false,
      sharingActive: bool(c.sharingActive) ?? false,
      shareSuspended: suspension(c.shareSuspended, scrub),
      consumingEnabled: bool(c.consumingEnabled) ?? false,
      nodeId: str(c.nodeId),
      hostname: str(c.hostname),
      networkName: str(c.networkName),
      virtualIpv4: str(c.virtualIpv4),
      proxyCidr: str(c.proxyCidr),
      mappedCidr: str(c.mappedCidr),
      publishedPorts: numbers(c.publishedPorts),
      secureMode: bool(c.secureMode) ?? false,
      rpcPort: num(c.rpcPort),
      listenAddr: str(c.listenAddr),
      share: { models: strings(share.models) },
      nativeProviders: strings(c.nativeProviders),
      remoteProviders: strings(c.remoteProviders),
      catalog: catalogConfig(c.catalog, scrub),
    },
    easytier: {
      sharingEnabled: bool(et.sharingEnabled) ?? false,
      consumingEnabled: bool(et.consumingEnabled) ?? false,
      hostname: str(et.hostname),
      running: bool(et.running) ?? false,
      pid: num(et.pid),
      startedAt: str(et.startedAt),
      restarts: num(et.restarts),
      lastError: text(et.lastError, scrub),
      coreVersion: str(et.coreVersion),
      networkName: str(et.networkName),
      virtualIpv4: str(et.virtualIpv4),
      proxyCidr: str(et.proxyCidr),
      mappedCidr: str(et.mappedCidr),
      publishedPorts: numbers(et.publishedPorts),
      secureMode: bool(et.secureMode) ?? false,
      socks5Port: num(et.socks5Port),
      aclOk: bool(et.aclOk) ?? false,
      aclProblems: texts(et.aclProblems, scrub),
      lastCheckAt: str(et.lastCheckAt),
      peers: list(et.peers).map((raw) => {
        const peer = obj(raw);
        return {
          hostname: str(peer.hostname),
          ipv4: str(peer.ipv4),
          route: str(peer.route) ?? str(peer.tunnel),
          tunnel: str(peer.tunnel),
          cost: str(peer.cost),
          latencyMs: str(peer.latencyMs) ?? num(peer.latencyMs),
          loss: str(peer.loss),
          nat: str(peer.nat),
        };
      }),
    },
    consumers,
    consumersSummary: consumerSummary(consumers),
    accounting: {
      intervalMs: num(a.intervalMs),
      maxDetectionMs: num(a.maxDetectionMs),
      lastCheckAt: str(a.lastCheckAt),
      lastCheckMs: num(a.lastCheckMs),
      lastOkAt: str(a.lastOkAt),
      failures: num(a.failures) ?? 0,
      uncertain: bool(a.uncertain) ?? false,
      uncertainReason: text(a.uncertainReason, scrub),
      serving: bool(a.serving) ?? false,
      paused: list(a.paused).map((raw) => {
        const pause = obj(raw);
        return {
          consumerId: str(pause.consumerId),
          reason: text(pause.reason, scrub),
          enforcement: str(pause.enforcement),
          enforced: bool(pause.enforced) ?? false,
        };
      }),
    },
    providers,
    providersSummary: providerSummary(providers),
    catalog: catalogView(s.catalog, scrub),
    checks: list(s.checks).map((x) => checkView(x, scrub)),
    checksAt: str(s.checksAt),
    checksDurationMs: num(s.checksDurationMs),
    readiness: readinessView(s.readiness, scrub),
    wallet: walletView(s.wallet, scrub),
  };
}
