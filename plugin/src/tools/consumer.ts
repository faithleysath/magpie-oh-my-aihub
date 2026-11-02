// The consumer side: request access, connect, disconnect, list connections.
//
// Everything here speaks the overlay protocol directly through the local
// EasyTier SOCKS5 listener. A request and a poll are EIP-191 signatures over
// `canonicalJson` made with this node's wallet, so the provider learns the
// wallet address — never an overlay address, which proves nothing.
//
// Connecting is idempotent: poll, then (only when a key is present) make sure a
// loopback forward exists, persist it, and register the peer as a Remote Magpie.
// The forward is added with the EasyTier CLI (no restart); the TOML keeps it
// across restarts. Disconnecting must restart the core: 2.6.4 cannot remove a
// forward at runtime, and the caller is told that other connections blink.

import { magpieClient, type Magpie, type ProviderRecord } from "../magpie.ts";
import { CONTROL_PORT, GATEWAY_PORT, SOCKS_PORT, type Overlay } from "../overlay.ts";
import { writeConfig, type HubConfig } from "../config.ts";
import { catalogTimestamp } from "../catalog-service.ts";
import type { Database } from "bun:sqlite";
import { listContacts } from "../contacts.ts";
import {
  countPendingClaims,
  formatUsd4,
  metaDelete,
  metaEntries,
  metaGet,
  metaSet,
  microFromUsd,
  payoutMicroTo,
} from "../db.ts";
import { cleanModelList, type PollResponse, type PollState } from "../grants.ts";
import { pollPayload, requestPayload } from "../http-router.ts";
import { logger } from "../log.ts";
import { getRuntime, type Runtime } from "../runtime.ts";
import { signCanonical } from "../signing.ts";
import { socksHttpRequest } from "../socks.ts";
import { peerEndpoint } from "./discover.ts";
import { isOurRemoteProvider, remoteProviderId, remoteProviderRoots } from "../remote-provider.ts";
import { fail, jsonText, objectArgs, requiredString, type ToolDef } from "./types.ts";
import { resolveTarget } from "./resolve.ts";

const POLL_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_PEER_BYTES = 32 * 1024;
const LOCAL_PORT_BASE = 13425;

const POLL_STATES = new Set<PollState>(["none", "pending", "approved", "revoked"]);

/**
 * The two things connect/disconnect do to the rest of the node, behind one
 * object so a test can drive the path without a real EasyTier core or the
 * user's Magpie. Production values are the only ones installed by default.
 */
export interface ConsumerDeps {
  /** builds a Magpie client; production resolves the running binary */
  magpie: () => Magpie;
  /** opens one loopback forward on the running core; true when it was added */
  addForward: (overlay: Overlay, bindAddr: string, dstAddr: string) => Promise<boolean>;
  /** rewrites the generated TOML and restarts a running core */
  applyConfig: (overlay: Overlay, cfg: HubConfig) => Promise<{ restarted: boolean }>;
  /** how long a freshly registered Remote Magpie gets to list its models */
  visibility: { attempts: number; delayMs: number };
}

const productionDeps: ConsumerDeps = {
  magpie: magpieClient,
  addForward: (overlay, bindAddr, dstAddr) => overlay.addForward(bindAddr, dstAddr),
  applyConfig: (overlay, cfg) => overlay.applyConfig(cfg),
  // `magpie models` can lag right behind `provider add`: retry, bounded.
  visibility: { attempts: 6, delayMs: 500 },
};

let deps: ConsumerDeps = productionDeps;

/**
 * Test seam. Returns a restore function. Production never calls it, so the
 * defaults above are what a real Magpie and a real overlay see.
 */
export function setConsumerDepsForTest(overrides: Partial<ConsumerDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...overrides };
  return () => {
    deps = previous;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 200) || "unknown error";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Defensive parse of the provider's answer; a peer cannot feed us garbage. */
function parsePoll(raw: string): PollResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("E_PEER_OFFLINE: the provider's poll answer is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("E_PEER_OFFLINE: the provider's poll answer is not an object");
  }
  const o = parsed as Record<string, unknown>;
  const state = typeof o.state === "string" ? (o.state as PollState) : null;
  if (!state || !POLL_STATES.has(state)) {
    throw new Error(`E_PEER_OFFLINE: the provider's poll answer has state ${String(o.state)}`);
  }
  const usd = (value: unknown): string => (typeof value === "string" ? value : "0.0000");
  const gatewayPort =
    typeof o.gatewayPort === "number" && Number.isInteger(o.gatewayPort) && o.gatewayPort > 0 && o.gatewayPort <= 65535
      ? o.gatewayPort
      : GATEWAY_PORT;
  return {
    state,
    grantedModels: isStringArray(o.grantedModels) ? o.grantedModels : [],
    balanceUsd: usd(o.balanceUsd),
    usedUsd: usd(o.usedUsd),
    remainingUsd: usd(o.remainingUsd),
    gatewayPort,
    key: typeof o.key === "string" && o.key.length > 0 ? o.key : null,
    ts: typeof o.ts === "string" ? o.ts : catalogTimestamp(),
  };
}

/** Signed `GET /request` against one peer's control endpoint. */
export async function signedPoll(runtime: Runtime, host: string): Promise<PollResponse> {
  const address = runtime.wallet.address.toLowerCase();
  const ts = catalogTimestamp();
  const payload = pollPayload(address, ts);
  const sig = await signCanonical(runtime.wallet, payload);
  const query = new URLSearchParams({ address, ts, sig }).toString();
  let response: { status: number; body: string };
  try {
    response = await socksHttpRequest({
      socksPort: SOCKS_PORT,
      host,
      port: CONTROL_PORT,
      path: `/request?${query}`,
      method: "GET",
      timeoutMs: POLL_TIMEOUT_MS,
      maxBytes: MAX_PEER_BYTES,
    });
  } catch (error) {
    throw new Error(`E_PEER_OFFLINE: cannot reach ${host}:${CONTROL_PORT} (${shortError(error)})`);
  }
  if (response.status === 403 || response.status === 400) {
    throw new Error(
      `E_PEER_OFFLINE: ${host} refused the poll with HTTP ${response.status} (${response.body.trim().slice(0, 120)})`,
    );
  }
  if (response.status !== 200) {
    throw new Error(`E_PEER_OFFLINE: ${host} answered the poll with HTTP ${response.status}`);
  }
  return parsePoll(response.body);
}

interface CachedPoll {
  state: PollState;
  grantedModels: string[];
  balanceUsd: string;
  usedUsd: string;
  remainingUsd: string;
  gatewayPort: number;
  ts: string;
}

/** Stores what the poll said, without the key: `status` must never print one. */
function rememberPoll(runtime: Runtime, provider: string, poll: PollResponse): void {
  const cached: CachedPoll = {
    state: poll.state,
    grantedModels: poll.grantedModels,
    balanceUsd: poll.balanceUsd,
    usedUsd: poll.usedUsd,
    remainingUsd: poll.remainingUsd,
    gatewayPort: poll.gatewayPort,
    ts: poll.ts,
  };
  metaSet(runtime.db, `poll:${provider}`, JSON.stringify(cached));
}

function cachedPoll(runtime: Runtime, provider: string): CachedPoll | null {
  const raw = metaGet(runtime.db, `poll:${provider}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedPoll;
    return parsed && POLL_STATES.has(parsed.state) ? parsed : null;
  } catch {
    return null;
  }
}

interface CachedRequest {
  provider: string;
  models: string[];
  state: PollState;
  ts: string;
}

function rememberRequest(runtime: Runtime, provider: string, models: string[], state: PollState, ts: string): void {
  const cached: CachedRequest = { provider, models, state, ts };
  metaSet(runtime.db, `request:${provider}`, JSON.stringify(cached));
}

/** The provider's response state, if the poll has one, updates our local log. */
function refreshRequestState(runtime: Runtime, provider: string, state: PollState, ts: string): void {
  const raw = metaGet(runtime.db, `request:${provider}`);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as CachedRequest;
    if (!parsed || !Array.isArray(parsed.models)) return;
    rememberRequest(runtime, provider, parsed.models, state, ts);
  } catch {
    /* a corrupt cache row is just forgotten */
  }
}

function describeProvider(record: ProviderRecord): string {
  const root = remoteProviderRoots(record)[0] ?? record.chat ?? "(no address)";
  return `preset ${record.preset ?? "?"} at ${root}`;
}

/**
 * `magpie models` can answer before the new Remote Magpie has fetched its list,
 * so the first read may be empty. Retry a bounded number of times before
 * calling it a failure; a transient read error is retried the same way.
 */
async function waitForVisibleModels(magpie: Magpie, id: string, granted: string[]): Promise<string[]> {
  const { attempts, delayMs } = deps.visibility;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const visible = visibleGranted(await magpie.modelIds(), granted);
      if (visible.length > 0) return visible;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  if (lastError) {
    throw new Error(
      `E_MAGPIE: the Remote Magpie ${id} was registered, but Magpie's model list cannot be read ` +
        `after ${attempts} attempts (${shortError(lastError)})`,
    );
  }
  throw new Error(
    `E_MAGPIE: the Remote Magpie ${id} was registered, but none of the granted models ` +
      `(${granted.join(", ")}) is visible after ${attempts} attempts; the provider may have changed the grant`,
  );
}

/**
 * What this Remote Magpie is called in Magpie's provider list.
 *
 * Magpie names every one of them "Remote magpie", so with two peers connected a
 * user cannot tell whose channel is whose. The address book is the name the user
 * chose for that peer, so it wins; the peer's signed hostname is the fallback,
 * and the short id is always appended so two peers cannot end up with the same
 * label.
 */
function remoteProviderName(
  db: Database,
  id: string,
  address: string,
  hostname: string | null,
): string {
  let alias: string | null = null;
  try {
    alias = listContacts(db).find((contact) => contact.address === address)?.alias ?? null;
  } catch {
    /* the address book is a convenience: its failure must not block a connect */
  }
  return `${alias ?? hostname ?? "Remote magpie"} (${id})`;
}

function visibleGranted(ids: string[], granted: string[]): string[] {
  return ids.filter((id) => granted.some((model) => id === model || id.endsWith(`/${model}`)));
}

function allocateLocalPort(runtime: Runtime): number {
  const used = new Set(runtime.config.connections.map((connection) => connection.localPort));
  for (let port = LOCAL_PORT_BASE; port <= 65535; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(`E_INPUT: no free local port from ${LOCAL_PORT_BASE} upwards`);
}

/** The models each Remote Magpie in our own Magpie currently serves. */
function localRemoteModels(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  try {
    const magpie = deps.magpie();
    for (const provider of magpie.providers()) {
      if (provider.id && Array.isArray(provider.models)) out.set(provider.id, provider.models);
    }
  } catch {
    /* a Magpie that cannot be located contributes nothing rather than failing status */
  }
  return out;
}

/** Compare what this wallet sent with the provider's last reported balance. */
function claimDiagnostics(
  runtime: Runtime,
  provider: string,
  reportedBalanceUsd: string | null,
): { localSentUsd: string; pendingClaims: number; providerBehind: boolean } {
  const localMicro = payoutMicroTo(runtime.db, provider);
  const reportedMicro = reportedBalanceUsd ? microFromUsd(Number(reportedBalanceUsd)) : 0n;
  return {
    localSentUsd: formatUsd4(localMicro),
    pendingClaims: countPendingClaims(runtime.db, provider),
    providerBehind: reportedBalanceUsd !== null && localMicro > reportedMicro,
  };
}

/**
 * `status.consuming`: what we asked for and what we hold. Read
 * from the ledger cache and state.json only — `status` must not depend on the
 * network being up.
 */
export function consumingSnapshot(runtime: Runtime): {
  requests: CachedRequest[];
  connections: {
    provider: string;
    models: string[];
    balanceUsd: string | null;
    usedUsd: string | null;
    remainingUsd: string | null;
    localSentUsd: string;
    pendingClaims: number;
    providerBehind: boolean;
    state: string;
    gatewayPort: number;
    localPort: number;
  }[];
} {
  const requests: CachedRequest[] = [];
  for (const row of metaEntries(runtime.db, "request:")) {
    try {
      const parsed = JSON.parse(row.v) as CachedRequest;
      if (parsed && typeof parsed.provider === "string" && Array.isArray(parsed.models)) requests.push(parsed);
    } catch {
      /* skip a corrupt row */
    }
  }

  const models = localRemoteModels();
  const connections = runtime.config.connections.map((connection) => {
    const cached = cachedPoll(runtime, connection.provider);
    return {
      provider: connection.provider,
      models: cached?.grantedModels ?? models.get(remoteProviderId(connection.provider)) ?? [],
      balanceUsd: cached?.balanceUsd ?? null,
      usedUsd: cached?.usedUsd ?? null,
      remainingUsd: cached?.remainingUsd ?? null,
      ...claimDiagnostics(runtime, connection.provider, cached?.balanceUsd ?? null),
      state: cached?.state ?? "unknown",
      gatewayPort: cached?.gatewayPort ?? GATEWAY_PORT,
      localPort: connection.localPort,
    };
  });
  return { requests, connections };
}

function requiredModels(args: Record<string, unknown>): string[] {
  return cleanModelList(args.models);
}

export const requestAccessTool: ToolDef = {
  description:
    "向某个提供方节点申请模型访问：用本节点钱包签名 POST /request（地址取自 discover 缓存，" +
    "没有缓存就先发现一次）。返回申请状态。对同一个节点重复申请只覆盖 requested_models，不会撤销已有授权。",
  args: {
    type: "object",
    properties: {
      provider: { type: "string", description: "提供方地址：0x…（来自 discover），或地址簿里的名字" },
      models: {
        type: "array",
        items: { type: "string" },
        description: "想申请的模型 id（提供方目录里的 id），非空",
      },
    },
    required: ["provider", "models"],
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const provider = await resolveTarget(requiredString(args, "provider", 64), "provider");
    const models = requiredModels(args);
    const runtime = await getRuntime();
    if (!runtime.config.network) fail("E_NO_NETWORK", "join a network before requesting access");

    const endpoint = await peerEndpoint(provider);
    const address = runtime.wallet.address.toLowerCase();
    const ts = catalogTimestamp();
    const payload = requestPayload(address, models, ts);
    const sig = await signCanonical(runtime.wallet, payload);
    const body = JSON.stringify({ ...payload, sig });
    if (Buffer.byteLength(body) > 16 * 1024) {
      fail("E_INPUT", `the signed request is larger than 16 KiB (${models.length} models)`);
    }

    let response: { status: number; body: string };
    try {
      response = await socksHttpRequest({
        socksPort: SOCKS_PORT,
        host: endpoint.host,
        port: CONTROL_PORT,
        path: "/request",
        method: "POST",
        body,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBytes: MAX_PEER_BYTES,
      });
    } catch (error) {
      throw new Error(`E_PEER_OFFLINE: cannot reach ${endpoint.host}:${CONTROL_PORT} (${shortError(error)})`);
    }

    let ack: { state?: unknown; requestedModels?: unknown; error?: unknown };
    try {
      ack = JSON.parse(response.body) as typeof ack;
    } catch {
      ack = {};
    }
    if (response.status !== 200) {
      const detail = typeof ack.error === "string" ? ack.error : response.body.trim().slice(0, 120);
      if (response.status === 429) fail("E_INPUT", `the provider is rate limiting this address: ${detail}`);
      if (response.status >= 500 || response.status === 0) {
        fail("E_PEER_OFFLINE", `the provider answered HTTP ${response.status}: ${detail}`);
      }
      fail("E_INPUT", `the provider refused the request with HTTP ${response.status}: ${detail}`);
    }
    const state = typeof ack.state === "string" ? (ack.state as PollState) : "pending";
    if (!POLL_STATES.has(state)) fail("E_PEER_OFFLINE", `the provider answered an unknown state ${String(ack.state)}`);
    const requestedModels = isStringArray(ack.requestedModels) ? ack.requestedModels : models;

    rememberRequest(runtime, provider, requestedModels, state, catalogTimestamp());
    return jsonText({ provider, state, requestedModels });
  },
};

export const connectTool: ToolDef = {
  description:
    "连接一个已批准的提供方：签名轮询 GET /request。pending 等待批准；approved 但没有 Key 表示等待充值；" +
    "拿到 Key 后分配本地转发口（13425 起）、加 EasyTier 转发、在 Magpie 里注册 Remote Magpie 并确认至少一个授权模型可见。" +
    "幂等，可反复调用；已连接时重复调用会刷新 Key 与模型。",
  args: {
    type: "object",
    properties: {
      provider: { type: "string", description: "提供方地址：0x…，或地址簿里的名字" },
    },
    required: ["provider"],
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const provider = await resolveTarget(requiredString(args, "provider", 64), "provider");
    const runtime = await getRuntime();
    if (!runtime.config.network) fail("E_NO_NETWORK", "join a network before connecting to a provider");

    const endpoint = await peerEndpoint(provider);
    const poll = await signedPoll(runtime, endpoint.host);
    rememberPoll(runtime, provider, poll);
    if (poll.state !== "none") refreshRequestState(runtime, provider, poll.state, catalogTimestamp());

    if (poll.state === "none") {
      fail("E_NOT_APPROVED", `${provider} has no application from ${runtime.wallet.address}; call request_access first`);
    }
    if (poll.state === "pending") {
      return jsonText({ provider, state: "pending" });
    }
    if (poll.state === "revoked") {
      fail("E_REVOKED", `${provider} revoked access for ${runtime.wallet.address}; ask for a new approval`);
    }
    if (!poll.key) {
      // state = approved and balance < $0.0001: the provider has granted the
      // models but has not issued a key yet.
      return jsonText({
        provider,
        state: "waiting-deposit",
        models: poll.grantedModels,
        balanceUsd: poll.balanceUsd,
      });
    }

    const existing = runtime.config.connections.find((connection) => connection.provider === provider) ?? null;
    const localPort = existing?.localPort ?? allocateLocalPort(runtime);
    const bindAddr = `127.0.0.1:${localPort}`;
    const dstAddr = `${endpoint.host}:${poll.gatewayPort}`;
    const id = remoteProviderId(provider);
    const url = `http://127.0.0.1:${localPort}`;
    const name = remoteProviderName(runtime.db, id, provider, endpoint.hostname);

    let magpie: Magpie;
    try {
      magpie = deps.magpie();
    } catch (error) {
      fail("E_MAGPIE", `cannot locate Magpie: ${shortError(error)}`);
    }
    // The id prefix is not proof of ownership. Refuse to clobber a provider a
    // user created with the same id (or a Remote Magpie of ours at another port).
    const record = magpie.providerById(id);
    if (record && !isOurRemoteProvider(record, id, localPort)) {
      fail(
        "E_INPUT",
        `Magpie already has a provider ${id} that this plugin did not create (${describeProvider(record)}); ` +
          `remove it in Magpie (or run disconnect_provider) before connecting ${provider}`,
      );
    }

    // Persist the connection first, then touch the core: a forward that fails
    // half-way must not leave a listener nobody recorded. The previous document
    // (which may still name the same connection) is written back on failure.
    const previous = runtime.config;
    const next = {
      ...runtime.config,
      connections: [
        ...runtime.config.connections.filter((connection) => connection.provider !== provider),
        { provider, localPort, peerHost: endpoint.host },
      ].sort((a, b) => a.provider.localeCompare(b.provider)),
    };
    try {
      writeConfig(next);
    } catch (error) {
      fail("E_PATH", `cannot write state.json: ${shortError(error)}`);
    }
    runtime.config = next;

    let forwardAdded: boolean;
    try {
      forwardAdded = await deps.addForward(runtime.overlay, bindAddr, dstAddr);
    } catch (error) {
      runtime.config = previous;
      try {
        writeConfig(previous);
      } catch (rollbackError) {
        logger.error(
          `connect ${provider}: the forward failed and state.json could not be rolled back ` +
            `(${shortError(rollbackError)}); the previous connection document is still on disk as .prev`,
        );
      }
      throw error;
    }

    try {
      if (record) await magpie.replaceRemoteProvider({ id, url, key: poll.key, name });
      else await magpie.addRemoteProvider({ id, url, key: poll.key, name });
    } catch (error) {
      fail("E_MAGPIE", `cannot register the Remote Magpie ${id}: ${shortError(error)}`);
    }

    const visible = await waitForVisibleModels(magpie, id, poll.grantedModels);

    logger.info(
      `connected ${provider} as ${id} on ${bindAddr} -> ${dstAddr} ` +
        `(${visible.length} visible models${forwardAdded ? ", new forward" : ""})`,
    );
    return jsonText({
      provider,
      state: "ready",
      models: poll.grantedModels,
      localPort,
      forwardAdded,
    });
  },
};

export const disconnectTool: ToolDef = {
  description:
    "断开一个提供方：删除本插件建的那条 Remote Magpie（id 以 omai- 开头），从 state.json 移除连接并重启 EasyTier 核心，" +
    "让本地转发真正消失（EasyTier 2.6.4 无法在运行时删除转发）。重启期间其他连接会短暂中断。",
  args: {
    type: "object",
    properties: {
      provider: { type: "string", description: "提供方地址：0x…，或地址簿里的名字" },
    },
    required: ["provider"],
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const provider = await resolveTarget(requiredString(args, "provider", 64), "provider");
    const runtime = await getRuntime();
    const connection = runtime.config.connections.find((entry) => entry.provider === provider) ?? null;
    const id = remoteProviderId(provider);
    let removed = false;
    let detail: string | undefined;

    // Only a provider this plugin demonstrably created is removed: a
    // `remote-magpie` whose root is the loopback forward recorded for this
    // connection. A hand-made entry with the same id is left alone, and without
    // a connection there is no port to prove ownership against.
    if (!connection) {
      detail = "no connection is recorded, so no Remote Magpie was removed (delete it in Magpie if it is stale)";
    } else {
      try {
        const magpie = deps.magpie();
        const record = magpie.providerById(id);
        if (!record) {
          removed = false;
        } else if (!isOurRemoteProvider(record, id, connection.localPort)) {
          detail = `refusing to delete ${id}: it is not the Remote Magpie this plugin created (${describeProvider(record)})`;
          logger.warn(`disconnect ${provider}: ${detail}`);
        } else {
          await magpie.removeProvider(id);
          removed = true;
        }
      } catch (error) {
        detail = `the Remote Magpie ${id} could not be removed: ${shortError(error)}`;
        logger.warn(`disconnect ${provider}: ${detail}`);
      }
    }

    if (!connection) {
      return jsonText({ provider, removed, forwardRemoved: false, restarted: false, ...(detail ? { detail } : {}) });
    }

    const next = {
      ...runtime.config,
      connections: runtime.config.connections.filter((entry) => entry.provider !== provider),
    };
    try {
      writeConfig(next);
    } catch (error) {
      fail("E_PATH", `cannot write state.json: ${shortError(error)}`);
    }
    runtime.config = next;
    metaDelete(runtime.db, `poll:${provider}`);

    // Removing the `[[port_forward]]` needs a restart: 2.6.4's remove prints
    // success and keeps the listener.
    let restarted = false;
    try {
      restarted = (await deps.applyConfig(runtime.overlay, next)).restarted;
    } catch (error) {
      const note = `EasyTier could not be restarted (${shortError(error)}); the forward disappears at the next restart`;
      detail = detail ? `${detail}; ${note}` : note;
      logger.warn(`disconnect ${provider}: ${note}`);
    }
    return jsonText({
      provider,
      removed,
      forwardRemoved: true,
      restarted,
      ...(restarted
        ? { note: "EasyTier restarted so the forward really disappears; other connections were interrupted briefly" }
        : {}),
      ...(detail ? { detail } : {}),
    });
  },
};

export const connectionsTool: ToolDef = {
  description:
    "列出本机持有的连接：提供方地址、授权模型、对方报告的余额/已用/剩余、本地已发送、待投递 claim、状态与本地转发口。" +
    "会签名轮询每个提供方（对方离线时用上次缓存的值并标 unknown）。localSentUsd > balanceUsd 或 providerBehind:true 表示对方可能还没记上账。",
  args: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    const runtime = await getRuntime();
    const connections = await Promise.all(
      runtime.config.connections.map(async (connection) => {
        const cached = cachedPoll(runtime, connection.provider);
        const base = {
          provider: connection.provider,
          models: cached?.grantedModels ?? [],
          balanceUsd: cached?.balanceUsd ?? null,
          usedUsd: cached?.usedUsd ?? null,
          remainingUsd: cached?.remainingUsd ?? null,
          ...claimDiagnostics(runtime, connection.provider, cached?.balanceUsd ?? null),
          state: cached?.state ?? "unknown",
          gatewayPort: cached?.gatewayPort ?? GATEWAY_PORT,
          localPort: connection.localPort,
        };
        if (!connection.peerHost) return base;
        try {
          const poll = await signedPoll(runtime, connection.peerHost);
          rememberPoll(runtime, connection.provider, poll);
          return {
            ...base,
            models: poll.grantedModels.length > 0 ? poll.grantedModels : base.models,
            balanceUsd: poll.balanceUsd,
            usedUsd: poll.usedUsd,
            remainingUsd: poll.remainingUsd,
            ...claimDiagnostics(runtime, connection.provider, poll.balanceUsd),
            state: poll.state,
            gatewayPort: poll.gatewayPort,
          };
        } catch {
          return base;
        }
      }),
    );
    return jsonText({ connections });
  },
};
