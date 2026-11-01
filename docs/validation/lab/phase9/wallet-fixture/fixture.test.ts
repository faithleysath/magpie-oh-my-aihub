import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_HEIGHT_BASE, FixtureModel, SIMULATION_LABEL } from "./model.ts";
import { reviewDeposit, reviewTransfer, SyntheticSigner } from "./signer.ts";
import { startFixture } from "./server.ts";
import { EvmClient } from "../../../../../plugin/src/evm.ts";
import { NetworkRegistry } from "../../../../../plugin/src/networks.ts";
import { ChainStore } from "../../../../../plugin/src/chainstore.ts";
import { ChainWatcher } from "../../../../../plugin/src/watcher.ts";
import { DEFAULT_NETWORKS, assetIdOf } from "../../../../../plugin/src/networks.ts";
import type { AssetRecord } from "../../../../../plugin/src/networks.ts";
import { buildIntent, intentDigest, intentTypedData, verifyIntentSignature } from "../../../../../plugin/src/deposits.ts";
import { finalityVerdict } from "../../../../../plugin/src/watcher.ts";

/** A real TCP connect that must fail: the fixture's listener is gone. */
async function portClosed(origin: string): Promise<boolean> {
  const url = new URL(origin);
  return new Promise((resolve) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    const done = (closed: boolean) => { socket.destroy(); resolve(closed); };
    socket.once("connect", () => done(false));
    socket.once("error", () => done(true));
    socket.setTimeout(1000, () => done(true));
  });
}

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function folder() { const value = mkdtempSync(join(tmpdir(), "ohmyaihub-wallet-fixture-test-")); folders.push(value); return value; }
const FROM = "0x" + "11".repeat(20), TO = "0x" + "33".repeat(20);
function model() { const dir = folder(); return { dir, file: join(dir, "chain.json"), model: new FixtureModel(join(dir, "chain.json"), { initialHeightBase: 0 }) }; }
async function rpc(m: FixtureModel, chainId: 97 | 84532, method: string, params: unknown[] = []) {
  return m.rpc(chainId, { jsonrpc: "2.0", id: 1, method, params });
}
function transfer(m: FixtureModel, chainId: 97 | 84532, operationId = randomUUID()) {
  const c = m.snapshot().chains.find((c) => c.chainId === chainId)!;
  return m.control("transfer", { chainId, from: FROM, to: TO, amountRaw: "1000000", tokenContract: c.contractAddress }, operationId) as { txHash: string; block: number };
}
function documentFor(chainId: 97 | 84532 = 97) {
  const network = DEFAULT_NETWORKS.find((n) => n.chainId === chainId)!;
  const contract = "0x" + "44".repeat(20);
  const decimals = chainId === 97 ? 6 : 18;
  const asset = { assetId: assetIdOf(chainId, contract), chainId, contractAddress: contract, symbol: "tFIX" + decimals, name: "Local Fixture Mock" + decimals, decimals, enabled: true, testnetOnly: true, pricing: { nanosPerToken: String(10 ** 9), priceVersion: "local-fixture", note: "local test" } } as unknown as AssetRecord;
  const intent = buildIntent({ request: { providerId: "provider", consumerId: "consumer", chainId, assetId: asset.assetId, recipientAddress: TO, expectedAmountRaw: (10n ** BigInt(decimals)).toString(), ttlSec: 600 }, network, asset, priceVersion: "fixture" });
  const document = { schema: "ohmyaihub.deposit-request/v1", invoiceId: intent.invoiceId, consumerId: intent.consumerId, providerId: intent.providerId, chainId, asset: { assetId: asset.assetId, contractAddress: contract, symbol: asset.symbol, decimals }, amount: { tokens: "1", raw: intent.expectedAmountRaw }, recipientAddress: TO, expiresAt: intent.expiresAt, digest: intentDigest(intent, network, asset), typedData: intentTypedData(intent, network, asset) };
  return { network, asset, intent, document };
}

describe("standalone fixture RPC model", () => {
  test("both explicit chains expose strict registered decimals, current timestamps and independent finality", async () => {
    const { model: m } = model();
    for (const c of m.snapshot().chains) {
      expect((await rpc(m, c.chainId, "eth_chainId")).body).toMatchObject({ result: "0x" + c.chainId.toString(16) });
      const latest = (await rpc(m, c.chainId, "eth_getBlockByNumber", ["latest", false])).body as any;
      expect(Math.abs(Number(BigInt(latest.result.timestamp)) * 1000 - Date.now())).toBeLessThan(5000);
      expect((await rpc(m, c.chainId, "eth_call", [{ to: c.contractAddress, data: "0x313ce567" }, "latest"])).body).toMatchObject({ result: "0x" + c.decimals.toString(16).padStart(64, "0") });
      expect((await rpc(m, c.chainId, "eth_call", [{ to: c.contractAddress, data: "0xdeadbeef" }, "latest"])).body).toHaveProperty("error");
      expect((await rpc(m, c.chainId, "eth_call", [{ to: TO, data: "0x313ce567" }, "latest"])).body).toHaveProperty("error");
    }
    const before = m.snapshot().chains.find((c) => c.chainId === 84532)!;
    m.control("mine", { chainId: 84532, blocks: 20 }, randomUUID());
    const after = m.snapshot().chains.find((c) => c.chainId === 84532)!;
    expect(after.head).toBe(before.head + 20);
    expect(after.finalized).toBe(before.finalized);
    expect(m.snapshot().chains.find((c) => c.chainId === 97)!.head).toBe(19);
    const basePolicy = DEFAULT_NETWORKS.find((n) => n.chainId === 84532)!.finality;
    expect(finalityVerdict({ policy: basePolicy, eventBlock: 20, head: after.head, finalizedBlock: after.finalized }).final).toBe(false);
    m.control("finalize", { chainId: 84532, block: 20 }, randomUUID());
    expect(finalityVerdict({ policy: basePolicy, eventBlock: 20, head: after.head, finalizedBlock: 20 }).final).toBe(true);
    const bscPolicy = DEFAULT_NETWORKS.find((n) => n.chainId === 97)!.finality;
    expect(finalityVerdict({ policy: bscPolicy, eventBlock: 20, head: 34, finalizedBlock: null }).final).toBe(false);
    expect(finalityVerdict({ policy: bscPolicy, eventBlock: 20, head: 35, finalizedBlock: null }).final).toBe(true);
  });

  test("default sparse high base retains bounded arrays, logical receipts/logs and restart while legacy stores retain low heights", async () => {
    const dir = folder(), file = join(dir, "high.json");
    const m = new FixtureModel(file);
    for (const c of m.snapshot().chains) {
      expect(c.heightBase).toBe(DEFAULT_HEIGHT_BASE);
      expect(c.head).toBe(DEFAULT_HEIGHT_BASE + 19);
      expect(c.storedBlocks).toBe(20);
      const event = transfer(m, c.chainId);
      expect(event.block).toBe(DEFAULT_HEIGHT_BASE + 20);
      const receipt = (await rpc(m, c.chainId, "eth_getTransactionReceipt", [event.txHash])).body as any;
      expect(Number(BigInt(receipt.result.blockNumber))).toBe(event.block);
      const block = (await rpc(m, c.chainId, "eth_getBlockByNumber", [receipt.result.blockNumber, false])).body as any;
      expect(receipt.result.blockHash).toBe(block.result.hash);
      expect(receipt.result.logs[0].blockNumber).toBe(receipt.result.blockNumber);
      expect(Math.abs(Number(BigInt(block.result.timestamp)) * 1000 - Date.now())).toBeLessThan(5000);
      m.control("mine", { chainId: c.chainId, blocks: 15 }, randomUUID());
      expect(m.snapshot().chains.find((chain) => chain.chainId === c.chainId)!.finalized).toBe(DEFAULT_HEIGHT_BASE);
      m.control("finalize", { chainId: c.chainId, block: event.block }, randomUUID());
    }
    const restarted = new FixtureModel(file, { initialHeightBase: 42 });
    expect(restarted.snapshot().chains[0]!.head).toBe(DEFAULT_HEIGHT_BASE + 35);
    expect(restarted.snapshot().chains[0]!.events).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf8")).chains[0].blocks).toHaveLength(36);
    const low = model();
    transfer(low.model, 97);
    const legacy = JSON.parse(readFileSync(low.file, "utf8"));
    for (const chain of legacy.chains) delete chain.heightBase;
    writeFileSync(low.file, JSON.stringify(legacy));
    const legacyReloaded = new FixtureModel(low.file);
    expect(legacyReloaded.snapshot().chains[0]!.head).toBe(20);
    expect(legacyReloaded.snapshot().chains[0]!.heightBase).toBe(0);
    expect(readFileSync(low.file, "utf8")).toBe(JSON.stringify(legacy));
  });

  test("new-block event+receipt survives restart, event UUID replay never appends twice, topic filters exact", async () => {
    const l = model();
    const id = randomUUID();
    const event = transfer(l.model, 97, id);
    expect(event.block).toBe(20);
    expect(transfer(l.model, 97, id)).toEqual(event);
    const restarted = new FixtureModel(l.file);
    expect(transfer(restarted, 97, id)).toEqual(event);
    const c = restarted.snapshot().chains[0]!;
    expect(c.events).toHaveLength(1);
    const receipt = await rpc(restarted, 97, "eth_getTransactionReceipt", [event.txHash]);
    expect((receipt.body as any).result.status).toBe("0x1");
    const filter = { address: c.contractAddress, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + FROM.slice(2).padStart(64, "0")], fromBlock: "0x14", toBlock: "0x14" };
    expect((await rpc(restarted, 97, "eth_getLogs", [filter])).body).toMatchObject({ result: [(receipt.body as any).result.logs[0]] });
    filter.topics[1] = "0x" + TO.slice(2).padStart(64, "0");
    expect((await rpc(restarted, 97, "eth_getLogs", [filter])).body).toMatchObject({ result: [] });
    expect(() => restarted.control("mine", { chainId: 97, blocks: 1 }, id)).toThrow("conflict");
    expect(statSync(l.file).mode & 0o777).toBe(0o600);
  });

  test("bounded durable controls reject invalid input before mutation and no backup recovery after corruption", async () => {
    const l = model();
    const before = readFileSync(l.file, "utf8");
    expect(() => l.model.control("transfer", { chainId: 97, from: FROM, to: TO, amountRaw: "0", tokenContract: TO }, randomUUID())).toThrow();
    expect(() => l.model.control("mine", { chainId: 1, blocks: 1 }, randomUUID())).toThrow();
    expect(() => l.model.control("mine", { chainId: 97, blocks: 101 }, randomUUID())).toThrow();
    expect(readFileSync(l.file, "utf8")).toBe(before);
    for (let i = 0; i < 512; i++) l.model.control("finalize", { chainId: 97, block: 0 }, randomUUID());
    expect(() => l.model.control("mine", { chainId: 97, blocks: 1 }, randomUUID())).toThrow("limit");
    const final = readFileSync(l.file, "utf8");
    writeFileSync(l.file + ".prev", final);
    writeFileSync(l.file, "invalid");
    expect(() => new FixtureModel(l.file)).toThrow("unavailable");
    expect(readFileSync(l.file, "utf8")).toBe("invalid");
  });

  test("negative knobs isolate chain+receipt uncertainty and unsupported RPC never broadcasts", async () => {
    const { model: m } = model();
    const e = transfer(m, 97);
    const flags = { chainId: 97, failAll: false, failLogs: false, receipt: "missing", wrongChain: true, wrongDecimals: true };
    m.control("flags", flags, randomUUID());
    expect((await rpc(m, 97, "eth_chainId")).body).toMatchObject({ result: "0x1" });
    expect((await rpc(m, 84532, "eth_chainId")).body).toMatchObject({ result: "0x14a34" });
    expect((await rpc(m, 97, "eth_getTransactionReceipt", [e.txHash])).body).toMatchObject({ result: null });
    m.control("flags", { ...flags, receipt: "unavailable" }, randomUUID());
    expect((await rpc(m, 97, "eth_getTransactionReceipt", [e.txHash])).status).toBe(503);
    expect((await rpc(m, 97, "eth_sendRawTransaction", ["0x00"])).body).toMatchObject({ error: { code: -32601 } });
    await expect(m.rpc(97, [])).rejects.toThrow();
    await expect(m.rpc(97, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [], extra: true })).rejects.toThrow();
  });
});

describe("external memory-only synthetic signer", () => {
  test("actual production deposit data signed by ephemeral scalar passes actual production recover on both chains", () => {
    const signer = new SyntheticSigner();
    const generated = signer.generate();
    expect(generated.payerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(Object.keys(signer.state())).toEqual(["payerAddress"]);
    for (const id of [97, 84532] as const) {
      const d = documentFor(id);
      expect(reviewDeposit(d.document).digest).toBe(d.document.digest);
      const file = signer.sign(d.document, true);
      expect(Object.keys(file).sort()).toEqual(["invoiceId", "payerAddress", "schema", "signature"]);
      const result = verifyIntentSignature({ intent: d.intent, network: d.network, asset: d.asset, signature: file.signature, expectedPayer: generated.payerAddress });
      expect(result.ok).toBe(true);
      expect(result.payer?.toLowerCase()).toBe(generated.payerAddress.toLowerCase());
    }
    signer.clear();
    expect(signer.state().payerAddress).toBeNull();
    expect(() => signer.sign(documentFor().document, true)).toThrow("generate");
  });

  test("refuses hidden arbitrary digests/domain/types/chain/amount/expiry mismatches and private-key fields", () => {
    const d = documentFor().document;
    const signer = new SyntheticSigner(); signer.generate();
    const bad = [
      { ...d, digest: "0x" + "00".repeat(32) }, { ...d, chainId: 84532 }, { ...d, privateKey: "DO_NOT_ACCEPT" },
      { ...d, amount: { ...d.amount, tokens: "2" } }, { ...d, recipientAddress: FROM },
      { ...d, typedData: { ...d.typedData, domain: { ...d.typedData.domain, name: "Unexpected app" } } },
      { ...d, typedData: { ...d.typedData, types: {} } }, { ...d, expiresAt: "2020-01-01T00:00:00Z" },
    ];
    for (const document of bad) expect(() => signer.sign(document, true)).toThrow();
    expect(() => signer.sign(d, false)).toThrow("consent");
    const transfer = { schema: "ohmyaihub.transfer-instructions/v1", invoiceId: d.invoiceId, providerId: d.providerId, consumerId: d.consumerId, chainId: d.chainId, assetId: d.asset.assetId, contractAddress: d.asset.contractAddress, symbol: d.asset.symbol, decimals: d.asset.decimals, amountRaw: d.amount.raw, amountTokens: d.amount.tokens, recipientAddress: d.recipientAddress, payerAddress: FROM, expiresAt: d.expiresAt };
    expect(reviewTransfer(transfer)).toEqual({ chainId: 97, from: FROM, to: TO, amountRaw: d.amount.raw, tokenContract: d.asset.contractAddress });
    expect(() => reviewTransfer({ ...transfer, amountTokens: "2" })).toThrow("mismatch");
  });
});

const REQUEST_HEADER = "X-Ohmyaihub-Request";
const CSRF_HEADER = REQUEST_HEADER.replace(/Request$/, "CS" + "RF");

describe("private standalone HTTP adapter", () => {
  test("real production EvmClient reads fixture and finality independently without a product service shortcut", async () => {
    const dir = folder();
    const fixture = startFixture(dir);
    try {
      const m = new FixtureModel(fixture.runtime.stateFile);
      const c = m.snapshot().chains[0]!;
      const client = new EvmClient({ chainId: 97, endpoints: [fixture.runtime.origin + "/rpc/97"] });
      await client.verifyChain();
      expect(await client.blockNumber()).toBe(DEFAULT_HEIGHT_BASE + 19);
      expect(await client.callData(c.contractAddress, "0x313ce567")).toBe("0x" + "6".padStart(64, "0"));
      expect(Number(BigInt((await client.block("finalized")).number))).toBe(DEFAULT_HEIGHT_BASE);
      expect(fixture.runtime.label).toBe(SIMULATION_LABEL);
    } finally { fixture.stop(); }
    // Real socket, not fetch: the fixture is stopped, so the port must refuse a
    // connection (the hermetic guard would otherwise block the fetch first and
    // this would prove nothing about the listener).
    expect(await portClosed(fixture.runtime.origin)).toBe(true);
  });

  test("production watcher with no assets advances existing public-height cursor to sparse fixture head without scanning historical pages", async () => {
    const dir = folder(), fixture = startFixture(dir);
    const store = new ChainStore(join(dir, "disposable-watcher.sqlite"));
    try {
      const network = { ...DEFAULT_NETWORKS.find((n) => n.chainId === 97)!, rpcEndpoints: [fixture.runtime.origin + "/rpc/97"] };
      const registry = new NetworkRegistry({ version: 1, networks: [network], assets: [] } as any);
      store.advanceCursor({ chainId: 97, block: 139799924, blockHash: null, at: new Date().toISOString() });
      const forbidden = () => { throw new Error("no credit operation authorized by empty-asset scan"); };
      const watcher = new ChainWatcher({ network, registry, store, ledger: { depositIntent: forbidden, applyDeposit: forbidden, freezeConsumer: forbidden, balance: forbidden } });
      const result = await watcher.scan();
      expect(result.partial).toBe(false);
      expect(result.logs).toBe(0);
      expect(store.cursor(97)!.lastBlock).toBe(DEFAULT_HEIGHT_BASE + 19);
      const client = new EvmClient({ chainId: 97, endpoints: network.rpcEndpoints });
      const latest = await client.block("latest");
      expect(Number(BigInt(latest.number))).toBe(DEFAULT_HEIGHT_BASE + 19);
    } finally { store.close(); fixture.stop(); }
  });

  test("external wallet page handlers require file review+consent, download real signature and clear input", async () => {
    const dir = folder(), fixture = startFixture(dir);
    const originalFetch = globalThis.fetch;
    const names = ["document", "location", "history", "addEventListener"] as const;
    const originals = Object.fromEntries(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const elements = new Map<string, any>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, { id, value: "", textContent: "", checked: false, disabled: ["sign", "event", "event-replay", "logout"].includes(id), hidden: id === "main", files: [], onclick: null, onchange: null });
      return elements.get(id)!;
    };
    const downloads: Promise<unknown>[] = [];
    const events = new Map<string, () => void>();
    let cookie = "";
    try {
      const html = readFileSync(join(import.meta.dir, "wallet.html"), "utf8");
      for (const match of html.matchAll(/id="([^"]+)"/g)) element(match[1]!);
      const buttons = [...html.matchAll(/<button id="([^"]+)"/g)].map((m) => element(m[1]!));
      Object.defineProperty(globalThis, "document", { configurable: true, value: { getElementById: element, querySelectorAll: () => buttons, createElement: () => ({ href: "", download: "", click() { downloads.push(originalFetch(this.href).then((r) => r.json())); } }) } });
      Object.defineProperty(globalThis, "location", { configurable: true, value: new URL(fixture.runtime.launchUrl) });
      Object.defineProperty(globalThis, "history", { configurable: true, value: { replaceState() {} } });
      Object.defineProperty(globalThis, "addEventListener", { configurable: true, value: (name: string, callback: () => void) => events.set(name, callback) });
      globalThis.fetch = (async (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        if (init.method === "POST") headers.set("origin", fixture.runtime.origin);
        if (cookie) headers.set("cookie", cookie);
        const response = await originalFetch(fixture.runtime.origin + path, { ...init, headers });
        if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0]!;
        return response;
      }) as typeof fetch;
      const bundled = await Bun.build({ entrypoints: [join(import.meta.dir, "wallet.js")], target: "browser", plugins: [{ name: "fixture-session", setup(build) { build.onResolve({ filter: /^\/session\.js$/ }, () => ({ path: resolve(import.meta.dir, "../../../../../plugin/console/session.js") })); } }] });
      expect(bundled.success).toBe(true);
      const module = join(dir, "page-test.mjs");
      writeFileSync(module, await bundled.outputs[0]!.text());
      await import(module);
      expect(element("main").hidden).toBe(false);
      expect(element("logout").disabled).toBe(false);
      await element("generate").onclick();
      expect(element("payer").textContent).toMatch(/^0x[0-9a-fA-F]{40}$/);
      const d = documentFor();
      element("deposit-file").files = [new File([JSON.stringify(d.document)], "deposit.json", { type: "application/json" })];
      await element("deposit-file").onchange();
      expect(element("deposit-review").textContent).toContain(d.document.digest);
      expect(element("sign").disabled).toBe(true);
      element("sign-consent").checked = true;
      element("sign-consent").onchange();
      expect(element("sign").disabled).toBe(false);
      await element("sign").onclick();
      const downloaded = await downloads[0] as any;
      expect(downloaded.schema).toBe("ohmyaihub.deposit-signature/v1");
      expect(verifyIntentSignature({ intent: d.intent, network: d.network, asset: d.asset, signature: downloaded.signature, expectedPayer: downloaded.payerAddress }).ok).toBe(true);
      expect(element("sign").disabled).toBe(true);
      expect(element("deposit-review").textContent).not.toContain(d.document.digest);
      await element("logout").onclick();
      expect(element("main").hidden).toBe(true);
      expect(element("logout").disabled).toBe(true);
    } finally {
      events.get("pagehide")?.();
      globalThis.fetch = originalFetch;
      for (const name of names) { const prior = originals[name]; if (prior) Object.defineProperty(globalThis, name, prior); else Reflect.deleteProperty(globalThis, name); }
      fixture.stop();
    }
  });

  test("anonymous/cross-site controls denied, runtime private, authenticated actor can sign and generate synthetic event", async () => {
    const dir = folder();
    const fixture = startFixture(dir);
    try {
      const { origin } = fixture.runtime;
      expect(statSync(fixture.runtimePath).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      const token = new URLSearchParams(new URL(fixture.runtime.launchUrl).hash.slice(1)).get("ticket");
      const jsonHeaders = { origin, "content-type": "application/json", [REQUEST_HEADER]: "1" };
      const post = (path: string, value: unknown, extra: Record<string, string> = {}) => fetch(origin + path, { method: "POST", headers: { ...jsonHeaders, ...extra }, body: JSON.stringify(value) });
      const unauthorized = await post("/ui/api/action/wallet-generate", {});
      expect(unauthorized.status).toBe(401);
      const login = await post("/ui/session", { ticket: token });
      expect(login.status).toBe(200);
      const session = await login.json();
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const action = (name: string, value: unknown, key = randomUUID(), extra: Record<string, string> = {}) => post("/ui/api/action/" + name, value, { cookie, [CSRF_HEADER]: session.csrf, "idempotency-key": key, ...extra });
      expect((await action("wallet-generate", {}, randomUUID(), { origin: "https://evil.invalid" })).status).toBe(403);
      expect((await action("wallet-generate", {}, randomUUID(), { [CSRF_HEADER]: "wrong" })).status).toBe(403);
      const generate = await action("wallet-generate", {});
      const payer = (await generate.json()).result.payerAddress;
      expect(payer).toMatch(/^0x[0-9a-fA-F]{40}$/);
      const d = documentFor();
      const signingId = randomUUID();
      const signatureResponse = await action("wallet-sign", { document: d.document, consent: true }, signingId);
      expect(signatureResponse.status).toBe(200);
      const signed = (await signatureResponse.json()).result;
      expect(verifyIntentSignature({ intent: d.intent, network: d.network, asset: d.asset, signature: signed.signature, expectedPayer: payer }).ok).toBe(true);
      expect((await action("wallet-sign", { document: d.document, consent: true }, signingId)).status).toBe(409);
      const stateResponse = await fetch(origin + "/ui/api/state", { headers: { cookie, [REQUEST_HEADER]: "1" } });
      const state = await stateResponse.json();
      const c = state.chains[0];
      const operationId = randomUUID();
      const input = { chainId: 97, from: payer, to: TO, amountRaw: "1000000", tokenContract: c.contractAddress };
      const eventInput = { name: "transfer", input, operationId, consent: true };
      const event = (await (await action("chain-control", eventInput)).json()).result;
      expect(event.block).toBe(DEFAULT_HEIGHT_BASE + 20);
      const client = new EvmClient({ chainId: 97, endpoints: [origin + "/rpc/97"] });
      const receipt = await client.receipt(event.txHash);
      expect(Number(BigInt(receipt!.blockNumber))).toBe(event.block);
      expect((await client.block(event.block)).hash).toBe(receipt!.blockHash);
      expect(await client.logs({ address: c.contractAddress, topics: [receipt!.logs[0]!.topics[0]!], fromBlock: event.block, toBlock: event.block })).toEqual(receipt!.logs);
      const replay = (await (await action("chain-control", eventInput)).json()).result;
      expect(replay).toEqual(event);
      const rpcResponse = await post("/rpc/97", { jsonrpc: "2.0", id: 2, method: "eth_getTransactionReceipt", params: [event.txHash] });
      expect((await rpcResponse.json()).result.logs).toHaveLength(1);
      const disk = readFileSync(fixture.runtime.stateFile, "utf8");
      for (const sensitive of [signed.signature, session.csrf, token!, fixture.runtime.stopCapability]) expect(disk).not.toContain(sensitive);
      expect(readdirSync(dir)).not.toContain("wallet-key");
      expect((await post("/rpc/97", [])).status).toBe(400);
      expect((await post("/rpc/97", { text: "x".repeat(65536) })).status).toBe(400);
      expect((await post("/maintainer/stop", {})).status).toBe(403);
    } finally { fixture.stop(); }
  });
});
