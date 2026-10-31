import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleHandler, ConsoleInputError } from "../src/console-server.ts";
import { NETWORK_LOCAL_ACTIONS, consoleNetworkAction, consoleNetworkState } from "../src/console-network.ts";
import { CONSOLE_ACTIONS, consoleAction } from "../src/console-api.ts";
import { ChainStore } from "../src/chainstore.ts";
import { Wallet } from "../src/wallet.ts";
import { productRegistry } from "../src/networks.ts";
import type { Service } from "../src/service.ts";
import type { CreditSink } from "../src/watcher.ts";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "network-local-")); dirs.push(dir); return dir; }

const ADDRESS = "0x3d80c477021e3fa568e91c73baec8e806518d9a6";
const BASE_USDC = "eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function word(value: bigint): string { return `0x${value.toString(16).padStart(64, "0")}`; }
function abiString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  return `0x${(32).toString(16).padStart(64, "0")}${bytes.length.toString(16).padStart(64, "0")}${hex}`;
}

class MockRpc {
  calls = 0;
  methods: string[] = [];
  reportedChainId = 8453;
  fail = false;
  balance = 1_234_567n;
  fetch = (async (_url: string, init?: RequestInit): Promise<Response> => {
    this.calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string; params: unknown[] };
    this.methods.push(body.method);
    if (this.fail) return new Response("unavailable", { status: 503 });
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
    switch (body.method) {
      case "eth_chainId": return reply(`0x${this.reportedChainId.toString(16)}`);
      case "eth_blockNumber": return reply("0x64");
      case "eth_getBalance": return reply(`0x${42n.toString(16)}`);
      case "eth_call": {
        const data = String((body.params[0] as { data?: string })?.data ?? "");
        if (data.startsWith("0x313ce567")) return reply(word(6n));
        if (data.startsWith("0x95d89b41")) return reply(abiString("USDC"));
        if (data.startsWith("0x70a08231")) return reply(word(this.balance));
        return reply("0x");
      }
      default: return reply("0x");
    }
  }) as typeof fetch;
}

function fixture() {
  const dir = temp();
  const registry = productRegistry();
  const store = new ChainStore(join(dir, "chain.sqlite"));
  const rpc = new MockRpc();
  const sink: CreditSink = {
    depositIntent: () => ({ created: true }),
    applyDeposit: async () => {},
    freezeConsumer: async () => {},
    balance: () => ({ depositedNanos: 0, consumedNanos: 0, balanceNanos: 0 }),
  };
  const wallet = new Wallet({
    credit: sink,
    registry,
    store,
    receivingPath: join(dir, "receiving.json"),
    readOnlyFetch: rpc.fetch,
    now: () => new Date("2026-10-31T00:00:00.000Z"),
  });
  const service = {
    config: () => ({ nodeId: "local-node" }),
    walletForConfiguration: () => wallet,
  } as unknown as Service;
  return { service, wallet, registry, rpc, dir };
}

async function act(service: Service, name: string, input: Record<string, unknown> = {}) {
  return consoleNetworkAction(service, name, input);
}

const CSRF_HEADER = "X-Ohmyaihub-Request".replace(/Request$/, "CS" + "RF");
function request(h: ReturnType<typeof createConsoleHandler>, path: string, options: { method?: string; body?: unknown; cookie?: string; csrf?: string; idempotency?: string; origin?: string | null } = {}) {
  const headers = new Headers({ host: `127.0.0.1:${h.port}`, "X-Ohmyaihub-Request": "1", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" });
  if (options.method === "POST") {
    if (options.origin !== null) headers.set("origin", options.origin ?? h.origin);
    headers.set("content-type", "application/json");
    headers.set("idempotency-key", options.idempotency ?? randomUUID());
  }
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.csrf) headers.set(CSRF_HEADER, options.csrf);
  return new Request(`${h.origin}${path}`, { method: options.method ?? "GET", headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
}

async function open(h: ReturnType<typeof createConsoleHandler>) {
  const ticket = new URLSearchParams(new URL(h.issueTicket()).hash.slice(1)).get("ticket")!;
  const response = await h.handle(request(h, "/ui/session", { method: "POST", body: { ticket } }));
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  return { cookie, ...(await response.json() as { csrf: string }) };
}

describe("network-local product projection", () => {
  test("state poll makes no RPC and keeps BSC/Base equal with native/token separation", () => {
    const { service, wallet, rpc } = fixture();
    const state = consoleNetworkState(service);
    expect(rpc.calls).toBe(0);
    expect(state.available).toBe(true);
    expect(state.configured).toBe(true);
    expect(state.product.networks.map((n) => n.chainId)).toEqual([56, 8453]);
    expect(state.product.networks.map((n) => n.nativeSymbol)).toEqual(["BNB", "ETH"]);
    expect(state.product.networks.every((n) => n.support === "read-only" && n.receivable)).toBe(true);
    expect(state.product.assets).toEqual([
      expect.objectContaining({ assetId: BASE_USDC, chainId: 8453, symbol: "USDC", decimals: 6, issuerType: "native-issuer", credit: false, pricingKind: "not-creditable" }),
    ]);
    expect(state.receiving.chainIds).toEqual([]);
    expect(state.readOnly).toBe(true);
    expect(state.creditEligible).toBe(false);
    expect(state.usdValue).toBeNull();
    const text = JSON.stringify(state);
    expect(text).not.toContain("mainnet.base.org");
    expect(text).not.toContain("bsc-dataseed");
    expect(text).not.toContain("creditEligible\":true");
    wallet.close();
  });

  test("receiving is explicitly single/double/clear, never auto-selects, and never starts a watcher", async () => {
    const { service, wallet } = fixture();
    expect(consoleNetworkState(service).receiving.chainIds).toEqual([]);
    await act(service, "network-local-receiving-set", { chainId: 56, selected: true });
    expect(consoleNetworkState(service).receiving.chainIds).toEqual([56]);
    await act(service, "network-local-receiving-set", { chainId: 8453, selected: true });
    expect(consoleNetworkState(service).receiving.chainIds).toEqual([56, 8453]);
    await act(service, "network-local-receiving-set", { chainId: 56, selected: false });
    expect(consoleNetworkState(service).receiving.chainIds).toEqual([8453]);
    await act(service, "network-local-receiving-set", { chainId: 8453, selected: false });
    expect(consoleNetworkState(service).receiving.chainIds).toEqual([]);
    await expect(act(service, "network-local-receiving-set", { chainId: 97, selected: true })).rejects.toBeInstanceOf(ConsoleInputError);
    await expect(act(service, "network-local-receiving-set", { providerId: "remote", chainId: 56, selected: true })).rejects.toBeInstanceOf(ConsoleInputError);
    expect(wallet.runningChains()).toEqual([]);
    wallet.close();
  });

  test("unselected chain remains refused for payment requests and selected mainnet is still credit-forbidden", async () => {
    const { service, wallet } = fixture();
    expect(wallet.paymentRequestVerdict("local-node", 56)).toMatchObject({ allowed: false, code: "receiving-network-not-selected" });
    await act(service, "network-local-receiving-set", { chainId: 56, selected: true });
    expect(wallet.paymentRequestVerdict("local-node", 56)).toMatchObject({ allowed: false, code: "mainnet-credit-forbidden" });
    expect(wallet.paymentRequestVerdict("local-node", 8453)).toMatchObject({ allowed: false, code: "receiving-network-not-selected" });
    expect(wallet.runningChains()).toEqual([]);
    wallet.close();
  });

  test("balance requires explicit watch context, stays read-only and unknown is not zero", async () => {
    const { service, wallet, rpc } = fixture();
    await expect(act(service, "network-local-balance-refresh", { chainId: 8453, address: ADDRESS, addressSource: "watch" })).rejects.toBeInstanceOf(ConsoleInputError);
    await expect(act(service, "network-local-balance-refresh", { chainId: 8453, address: ADDRESS, addressSource: "wallet" })).rejects.toBeInstanceOf(ConsoleInputError);
    await act(service, "network-local-watch-address", { address: ADDRESS });
    expect(rpc.calls).toBe(0);
    const refreshed = await act(service, "network-local-balance-refresh", { chainId: 8453, address: ADDRESS, assetId: BASE_USDC, addressSource: "watch" }) as { balance: any };
    expect(refreshed.balance).toMatchObject({ state: "ok", chainId: 8453, readOnly: true, creditEligible: false, usdValue: null, balanceRaw: "1234567", decimals: 6 });
    expect(refreshed.balance.asset).toMatchObject({ assetId: BASE_USDC, symbol: "USDC" });
    expect(new Set(rpc.methods)).toEqual(new Set(["eth_chainId", "eth_blockNumber", "eth_call"]));
    const callsAfterRefresh = rpc.calls;
    const polled = consoleNetworkState(service);
    expect(polled.lastBalance).toMatchObject({ state: "ok", balanceRaw: "1234567", creditEligible: false, usdValue: null });
    expect(rpc.calls).toBe(callsAfterRefresh);

    rpc.fail = true;
    const unknown = await act(service, "network-local-balance-refresh", { chainId: 8453, address: ADDRESS, assetId: BASE_USDC, addressSource: "watch" }) as { balance: any };
    expect(unknown.balance).toMatchObject({ state: "unknown", readOnly: true, creditEligible: false, usdValue: null, errorCode: "balance_unavailable" });
    expect(unknown.balance).not.toHaveProperty("balanceRaw");
    const callsAfterUnknown = rpc.calls;
    expect(consoleNetworkState(service).lastBalance).toMatchObject({ state: "unknown" });
    expect(rpc.calls).toBe(callsAfterUnknown);
    expect(wallet.runningChains()).toEqual([]);
    wallet.close();
  });

  test("native BNB and approved Base token remain distinct", async () => {
    const { service, wallet, rpc } = fixture();
    await act(service, "network-local-watch-address", { address: ADDRESS });
    rpc.reportedChainId = 56;
    const bnb = await act(service, "network-local-balance-refresh", { chainId: 56, address: ADDRESS, addressSource: "watch" }) as { balance: any };
    expect(bnb.balance).toMatchObject({ state: "ok", chainId: 56, asset: null, nativeSymbol: "BNB", balanceRaw: "42", decimals: 18, creditEligible: false, usdValue: null });
    rpc.reportedChainId = 8453;
    const usdc = await act(service, "network-local-balance-refresh", { chainId: 8453, address: ADDRESS, assetId: BASE_USDC, addressSource: "watch" }) as { balance: any };
    expect(usdc.balance).toMatchObject({ state: "ok", chainId: 8453, asset: expect.objectContaining({ assetId: BASE_USDC, symbol: "USDC" }), creditEligible: false, usdValue: null });
    wallet.close();
  });

  test("unsupported assets and wrong-chain RPC evidence are refused/unknown, never numeric", async () => {
    const { service, wallet, rpc } = fixture();
    await act(service, "network-local-watch-address", { address: ADDRESS });
    await expect(act(service, "network-local-balance-refresh", { chainId: 56, address: ADDRESS, assetId: "eip155:56:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", addressSource: "watch" })).rejects.toBeInstanceOf(ConsoleInputError);
    await expect(act(service, "network-local-balance-refresh", { chainId: 8453, address: ADDRESS, assetId: BASE_USDC, addressSource: "watch", store: {} })).rejects.toBeInstanceOf(ConsoleInputError);
    rpc.reportedChainId = 56;
    const wrong = await act(service, "network-local-balance-refresh", { chainId: 8453, address: ADDRESS, assetId: BASE_USDC, addressSource: "watch" }) as { balance: any };
    expect(wrong.balance).toMatchObject({ state: "unknown", errorCode: "balance_unavailable" });
    expect(wrong.balance).not.toHaveProperty("balanceRaw");
    wallet.close();
  });
});

describe("network-local console auth boundary", () => {
  test("the named actions are registered and dispatch through the console action adapter", async () => {
    const { service, wallet } = fixture();
    for (const name of NETWORK_LOCAL_ACTIONS) expect(CONSOLE_ACTIONS).toContain(name);
    expect(await consoleAction(service, "network-local-state", {})).toMatchObject({ schema: "ohmyaihub.network-local/v1", readOnly: true });
    wallet.close();
  });

  test("real session/CSRF/UUID gates apply and state is local-only", async () => {
    const { service, wallet } = fixture();
    const h = createConsoleHandler({
      state: async () => ({ networkLocal: consoleNetworkState(service) }),
      action: async (name, input) => consoleNetworkAction(service, name, input),
      allowedActions: NETWORK_LOCAL_ACTIONS,
    }, 39992);
    const session = await open(h);
    const state = await h.handle(request(h, "/ui/api/state", { cookie: session.cookie, csrf: session.csrf }));
    expect(state.status).toBe(200);
    expect(JSON.stringify(await state.json())).not.toContain("mainnet.base.org");
    const missingCsrf = await h.handle(request(h, "/ui/api/action/network-local-state", { method: "POST", body: {}, cookie: session.cookie }));
    expect(missingCsrf.status).toBe(403);
    const noUuid = await h.handle(request(h, "/ui/api/action/network-local-state", { method: "POST", body: {}, cookie: session.cookie, csrf: session.csrf, idempotency: "not-uuid" }));
    expect(noUuid.status).toBe(400);
    const ok = await h.handle(request(h, "/ui/api/action/network-local-state", { method: "POST", body: {}, cookie: session.cookie, csrf: session.csrf }));
    expect(ok.status).toBe(200);
    expect((await ok.json() as { result: unknown }).result).toMatchObject({ schema: "ohmyaihub.network-local/v1", creditEligible: false, usdValue: null });
    wallet.close();
  });
});
