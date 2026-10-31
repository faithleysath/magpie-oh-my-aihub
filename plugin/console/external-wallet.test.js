import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEPOSIT_TYPES, EIP6963_ANNOUNCE, EIP6963_REQUEST, MAINNET_CHAIN_IDS, TESTNET_CHAIN_IDS,
  WALLET_ERROR, assertNoMainnetSend, createExternalWallet, createWalletDiscovery, formatUnits, isMainnetChainId, recoverTypedDataSigner,
  safeWalletIcon, sanitizeWalletInfo, typedDataDigest, validateDepositDocument,
} from "./external-wallet.js";
import { typedDataDigest as serverTypedDataDigest } from "../src/eip712.ts";
import { recoverAddress } from "../src/secp256k1.ts";
import { signDigest, TEST_PAYER, TEST_STRANGER, TEST_PAYER_KEY } from "../test/support/signer.ts";
import { fromHex } from "../src/keccak.ts";

const CONTRACT = "0x" + "2".repeat(40);
const CONTRACT_18 = "0x" + "5".repeat(40);
const RECIPIENT = "0x" + "3".repeat(40);
const ASSET_97 = `eip155:97:${CONTRACT.toLowerCase()}`;
const ASSET_84532 = `eip155:84532:${CONTRACT_18.toLowerCase()}`;
const ASSET_56 = `eip155:56:${CONTRACT.toLowerCase()}`;
const NOW = 1_800_000_000_000; // fixed wall clock for previews/documents
const NOW_SEC = Math.floor(NOW / 1000);
const HASH = "0x" + "a".repeat(64);
const TX_HASH = "0x" + "b".repeat(64);
const ZERO32 = "0x" + "0".repeat(64);

const registryFixture = () => ({
  networks: [
    { chainId: 97, displayName: "BSC Testnet", family: "evm", networkType: "testnet", enabled: true, support: "credit", receivable: true, nativeSymbol: "tBNB" },
    { chainId: 84532, displayName: "Base Sepolia", family: "evm", networkType: "testnet", enabled: true, support: "credit", receivable: true, nativeSymbol: "ETH" },
    { chainId: 56, displayName: "BNB Smart Chain", family: "evm", networkType: "mainnet", enabled: false, support: "read-only", receivable: false, nativeSymbol: "BNB" },
  ],
  assets: [
    { assetId: ASSET_97, chainId: 97, contractAddress: CONTRACT, symbol: "tMOCK6", decimals: 6, issuerType: "mock", testnetOnly: true, enabled: true, credit: true, pricing: { kind: "fixed-test-rate" } },
    { assetId: ASSET_84532, chainId: 84532, contractAddress: CONTRACT_18, symbol: "tMOCK18", decimals: 18, issuerType: "mock", testnetOnly: true, enabled: true, credit: true, pricing: { kind: "fixed-test-rate" } },
    { assetId: ASSET_56, chainId: 56, contractAddress: CONTRACT, symbol: "MAIN", decimals: 6, issuerType: "native-issuer", testnetOnly: false, enabled: false, credit: false, pricing: { kind: "not-creditable" } },
    { assetId: "eip155:97:0x" + "9".repeat(40), chainId: 97, contractAddress: "0x" + "9".repeat(40), symbol: "tBAD", decimals: 99, issuerType: "mock", testnetOnly: true, enabled: true, credit: true, pricing: { kind: "fixed-test-rate" } },
    { assetId: "eip155:97:0x" + "8".repeat(40), chainId: 97, contractAddress: "0x" + "8".repeat(40), symbol: "tMYSTERY", decimals: 6, issuerType: "mystery", testnetOnly: true, enabled: true, credit: true, pricing: { kind: "fixed-test-rate" } },
    { assetId: "eip155:97:0x" + "7".repeat(40), chainId: 97, contractAddress: "0x" + "7".repeat(40), symbol: "tOFF", decimals: 6, issuerType: "mock", testnetOnly: true, enabled: false, credit: true, pricing: { kind: "fixed-test-rate" } },
    { assetId: "eip155:97:0x" + "a".repeat(40), chainId: 97, contractAddress: "0x" + "a".repeat(40), symbol: "tNOCREDIT", decimals: 6, issuerType: "mock", testnetOnly: true, enabled: true, credit: false, pricing: { kind: "not-creditable" } },
  ],
});

function depositDocument(overrides = {}) {
  const chainId = overrides.chainId ?? 97;
  const contractAddress = overrides.contractAddress ?? CONTRACT;
  const decimals = overrides.decimals ?? 6;
  const raw = overrides.raw ?? "1000001";
  const recipient = overrides.recipient ?? RECIPIENT;
  const assetId = overrides.assetId ?? `eip155:${chainId}:${contractAddress.toLowerCase()}`;
  const requestedAt = overrides.requestedAt ?? NOW_SEC;
  const expiresAt = overrides.expiresAt ?? NOW_SEC + 3600;
  const message = {
    invoiceId: overrides.invoiceId ?? "invoice-1",
    consumerId: overrides.consumerId ?? "consumer-1",
    providerId: overrides.providerId ?? "provider-1",
    chainId,
    assetId,
    tokenContract: contractAddress,
    recipient,
    expectedAmountRaw: raw,
    nonce: overrides.nonce ?? "0x" + "c".repeat(32),
    requestedAt,
    expiresAt,
  };
  const typedData = {
    types: DEPOSIT_TYPES,
    primaryType: "DepositIntent",
    domain: { name: "Oh My AI Hub", version: "1", chainId, verifyingContract: "0x000000000000000000000000000000000000a1b2" },
    message,
  };
  return {
    schema: "ohmyaihub.deposit-request/v1",
    invoiceId: message.invoiceId,
    consumerId: message.consumerId,
    providerId: message.providerId,
    chainId,
    asset: { assetId, contractAddress, symbol: overrides.symbol ?? (decimals === 6 ? "tMOCK6" : "tMOCK18"), decimals },
    amount: { tokens: formatUnits(raw, decimals), raw },
    recipientAddress: recipient,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    digest: typedDataDigest(typedData),
    typedData,
  };
}

function fakeProvider(overrides = {}) {
  const calls = [];
  const listeners = new Map();
  const provider = {
    calls,
    async request(call) {
      calls.push(structuredClone(call));
      const handler = overrides[call.method];
      if (!handler) throw Object.assign(new Error("unsupported method"), { code: 4200 });
      return await handler(call.params, call);
    },
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
    },
    removeListener(event, handler) { listeners.get(event)?.delete(handler); },
    emit(event, value) { for (const handler of [...(listeners.get(event) ?? [])]) handler(value); },
    listenerCount(event) { return listeners.get(event)?.size ?? 0; },
  };
  return provider;
}

function walletInfo(name, uuid, icon) {
  return {
    uuid: uuid ?? "11111111-1111-4111-8111-111111111111",
    name,
    icon: icon ?? "data:image/png;base64,iVBORw0KGgo=",
    rdns: "io.example." + name.toLowerCase().replace(/[^a-z0-9]/g, ""),
  };
}

function discoveryFixture({ wallets = [], legacy = null } = {}) {
  const target = new EventTarget();
  if (legacy) target.ethereum = legacy;
  const discovery = createWalletDiscovery({ target, now: () => NOW });
  const stop = [];
  for (const wallet of wallets) {
    const announce = () => target.dispatchEvent(new CustomEvent(EIP6963_ANNOUNCE, { detail: wallet }));
    target.addEventListener(EIP6963_REQUEST, announce);
    stop.push(() => target.removeEventListener(EIP6963_REQUEST, announce));
    announce();
  }
  discovery.start();
  return { target, discovery, stop };
}

function defaultProvider(overrides = {}) {
  let chain = "0x61";
  let accounts = [TEST_PAYER];
  let gasPrice = "0x3b9aca00";
  let tokenBalance = '0x1e8480'; // 2,000,000 base units of 6 decimals
  let nativeBalance = "0xde0b6b3a7640000"; // 1e18
  let receipt = null;
  const provider = fakeProvider({
    eth_requestAccounts: async () => accounts,
    eth_accounts: async () => accounts,
    eth_chainId: async () => chain,
    eth_getBalance: async () => nativeBalance,
    eth_call: async () => tokenBalance,
    eth_estimateGas: async () => "0xc350",
    eth_gasPrice: async () => gasPrice,
    eth_signTypedData_v4: async (params) => signDigest(typedDataDigest(JSON.parse(params[1])), TEST_PAYER_KEY),
    eth_sendTransaction: async () => TX_HASH,
    eth_getTransactionReceipt: async () => receipt,
    wallet_switchEthereumChain: async () => null,
    ...overrides,
  });
  return {
    provider,
    setChain(value) { chain = value; },
    setAccounts(value) { accounts = value; },
    setGasPrice(value) { gasPrice = value; },
    setTokenBalance(value) { tokenBalance = value; },
    setNativeBalance(value) { nativeBalance = value; },
    setReceipt(value) { receipt = value; },
  };
}

/** Simulated durable journal; tests only. Not a Service implementation. */
function memoryOperationPort() {
  const entries = new Map();
  const calls = [];
  let sequence = 0;
  const keyOf = (operation) => JSON.stringify(Object.fromEntries(Object.entries(operation).sort()));
  const api = {
    calls,
    get state() { return entries.size === 1 ? [...entries.values()][0].state : null; },
    get entry() { return entries.size === 1 ? [...entries.values()][0] : null; },
    reserve(operation) {
      calls.push({ name: "reserve", operation: structuredClone(operation) });
      const key = keyOf(operation);
      let entry = entries.get(key);
      if (!entry) {
        entry = { id: `op-${++sequence}`, state: "reserved", hash: null, operation };
        entries.set(key, entry);
      }
      return { reservationId: entry.id, state: entry.state, hash: entry.hash };
    },
    markBroadcasting({ reservationId, operation }) {
      calls.push({ name: "markBroadcasting", reservationId, operation: structuredClone(operation) });
      const entry = [...entries.values()].find((value) => value.id === reservationId);
      if (!entry || entry.state !== "reserved") throw new Error("journal reservation is not reserved");
      entry.state = "broadcasting";
    },
    recordHash({ reservationId, operation, hash }) {
      calls.push({ name: "recordHash", reservationId, operation: structuredClone(operation), hash });
      const entry = [...entries.values()].find((value) => value.id === reservationId);
      if (!entry) throw new Error("journal reservation missing");
      entry.state = "broadcast"; entry.hash = hash;
    },
    recordUnknown({ reservationId, operation, reason }) {
      calls.push({ name: "recordUnknown", reservationId, operation: structuredClone(operation), reason });
      const entry = [...entries.values()].find((value) => value.id === reservationId);
      if (!entry) throw new Error("journal reservation missing");
      entry.state = "unknown"; entry.reason = reason;
    },
    query(operation) {
      calls.push({ name: "query", operation: structuredClone(operation) });
      const entry = entries.get(keyOf(operation));
      return entry ? { state: entry.state, hash: entry.hash } : null;
    },
  };
  return api;
}

function sessionFixture({ provider = defaultProvider(), registry = registryFixture(), allowMainnetRead = false, allowedChainIds, timeouts = {}, now = () => NOW, info = walletInfo("Test Wallet"), operationPort = null } = {}) {
  const wallet = { info, provider: provider.provider };
  const { discovery } = discoveryFixture({ wallets: [wallet] });
  const selection = discovery.list()[0];
  const session = createExternalWallet({ discovery, selectionId: selection.id, registry, allowMainnetRead, allowedChainIds, timeouts, now, operationPort });
  return { provider, session, discovery, wallet };
}

async function connectedFixture(options = {}) {
  const fixture = sessionFixture({ ...options, operationPort: options.operationPort === undefined ? memoryOperationPort() : options.operationPort });
  const state = await fixture.session.connect({ userInitiated: true });
  return { ...fixture, state };
}

const expectCode = async (promise, code) => {
  try { await promise; } catch (error) { expect(error.code).toBe(code); return error; }
  throw new Error(`expected ${code}`);
};

describe("exact amounts and EIP-712 browser port", () => {
  test("formatUnits is exact and never uses floating point", () => {
    expect(formatUnits("1000001", 6)).toBe("1.000001");
    expect(formatUnits("1", 18)).toBe("0.000000000000000001");
    expect(formatUnits("1000000000000000000", 18)).toBe("1");
    expect(formatUnits("0", 6)).toBe("0");
    for (const raw of ["", "01", "-1", "1.0", "1e3"]) expect(() => formatUnits(raw, 6)).toThrow();
  });

  test("browser Keccak/EIP-712/recovery match the audited TypeScript implementation", () => {
    const document = depositDocument();
    expect(typedDataDigest(document.typedData)).toBe(serverTypedDataDigest(document.typedData));
    expect(typedDataDigest(document.typedData)).toBe(document.digest);
    const signature = signDigest(document.digest);
    expect(recoverTypedDataSigner(document.digest, signature)).toBe(recoverAddress(fromHex(document.digest), signature));
    expect(recoverTypedDataSigner(document.digest, signature).toLowerCase()).toBe(TEST_PAYER.toLowerCase());
    expect(recoverTypedDataSigner(document.digest, "0x" + "1".repeat(130))).toBeNull();
    const worse = signature.slice(0, 130) + (parseInt(signature.slice(130), 16) > 27 ? "1a" : "1b");
    expect(recoverTypedDataSigner(document.digest, worse)).toBeDefined();
  });

  test("validateDepositDocument rejects exact-field, chain, amount, expiry and digest changes", () => {
    const valid = depositDocument();
    expect(validateDepositDocument(valid, { now: NOW }).digest).toBe(valid.digest);
    const cases = [
      [{ ...valid, extra: true }, WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT],
      [{ ...valid, chainId: 56 }, WALLET_ERROR.MAINNET_BLOCKED],
      [{ ...valid, chainId: 1 }, WALLET_ERROR.UNKNOWN_CHAIN],
      [{ ...valid, amount: { ...valid.amount, tokens: "1.000002" } }, WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT],
      [{ ...valid, amount: { ...valid.amount, raw: "0" } }, WALLET_ERROR.INVALID_AMOUNT],
      [{ ...valid, expiresAt: new Date((NOW_SEC - 1) * 1000).toISOString() }, WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT],
      [{ ...valid, digest: ZERO32 }, WALLET_ERROR.DIGEST_MISMATCH],
      [{ ...valid, typedData: { ...valid.typedData, domain: { ...valid.typedData.domain, chainId: 84532 } } }, WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT],
      [{ ...valid, typedData: { ...valid.typedData, message: { ...valid.typedData.message, recipient: "0x" + "4".repeat(40) } } }, WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT],
      [{ ...valid, typedData: { ...valid.typedData, types: { ...valid.typedData.types, DepositIntent: [...valid.typedData.types.DepositIntent, { name: "extra", type: "string" }] } } }, WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT],
    ];
    for (const [document, code] of cases) {
      try { validateDepositDocument(document, { now: NOW }); throw new Error("accepted invalid document"); }
      catch (error) { expect(error.code).toBe(code); }
    }
    expect(validateDepositDocument(valid, { now: NOW, expectedIntentHash: valid.digest }).digest).toBe(valid.digest);
    expect(() => validateDepositDocument(valid, { now: NOW, expectedIntentHash: HASH })).toThrow();
  });
});

describe("EIP-6963 discovery and untrusted info", () => {
  test("discovers two wallets, keeps provider references, and never auto-selects or requests accounts", () => {
    const a = defaultProvider();
    const b = defaultProvider();
    const { discovery } = discoveryFixture({ wallets: [
      { info: walletInfo("Alpha", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), provider: a.provider },
      { info: walletInfo("Beta", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), provider: b.provider },
    ] });
    expect(discovery.list().map((entry) => entry.name).sort()).toEqual(["Alpha", "Beta"]);
    expect(discovery.selectedId).toBeNull();
    expect(a.provider.calls).toHaveLength(0);
    expect(b.provider.calls).toHaveLength(0);
    const alpha = discovery.list().find((entry) => entry.name === "Alpha");
    const selected = discovery.select(alpha.id);
    expect(selected.provider).toBe(a.provider);
    expect(selected.info.identity).toBe("unverified");
    expect(discovery.selectedId).toBe(alpha.id);
    expect(discovery.list().find((entry) => entry.name === "Beta").selected).toBe(false);
  });

  test("legacy window.ethereum is an explicit choice and is never read automatically", () => {
    const legacy = defaultProvider();
    const { discovery } = discoveryFixture({ legacy: legacy.provider });
    expect(discovery.list()).toHaveLength(0);
    expect(discovery.legacy()).toMatchObject({ id: "legacy", identity: "unverified" });
    expect(legacy.provider.calls).toHaveLength(0);
    const selected = discovery.select("legacy");
    expect(selected.provider).toBe(legacy.provider);
    expect(selected.info.warnings).toContain("legacy-no-eip6963");
    expect(legacy.provider.calls).toHaveLength(0);
  });

  test("sanitizes names/rdns/icons and flags duplicate uuid without merging providers", () => {
    const a = { info: { uuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "<img src=x onerror=alert(1)>", rdns: "io.example\n<script>", icon: "data:image/svg+xml;base64," + btoa('<svg><script>alert(1)</script></svg>') }, provider: fakeProvider() };
    const b = { info: { uuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Same UUID", rdns: "io.example.same", icon: "data:image/png;base64,iVBORw0KGgo=" }, provider: fakeProvider() };
    const { discovery } = discoveryFixture({ wallets: [a, b] });
    const entries = discovery.list();
    expect(entries).toHaveLength(2);
    expect(entries[0].name).not.toContain("<");
    expect(entries[0].name).not.toContain(">");
    expect(entries[0].icon).toBeNull();
    expect(entries[0].initial).toBe("i");
    expect(entries[0].warnings).toContain("icon-not-rendered");
    expect(entries[1].warnings).toContain("uuid-claimed-by-multiple-providers");
    expect(entries[0].warnings).toContain("uuid-claimed-by-multiple-providers");
    expect(discovery.select(entries[0].id).provider).toBe(a.provider);
    expect(discovery.select(entries[1].id).provider).toBe(b.provider);
  });

  test("re-announcement updates display metadata but keeps the same internal id and provider", () => {
    const provider = fakeProvider();
    const wallet = { info: walletInfo("First", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"), provider };
    const { discovery, target } = discoveryFixture({ wallets: [wallet] });
    const before = discovery.list()[0];
    wallet.info = walletInfo("Second", "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    target.dispatchEvent(new CustomEvent(EIP6963_ANNOUNCE, { detail: wallet }));
    const after = discovery.list();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect(after[0].name).toBe("Second");
    expect(discovery.select(after[0].id).provider).toBe(provider);
  });

  test("never renders remote data/SVG icons; uses a sanitized name initial instead", () => {
    for (const icon of [
      "data:image/png;base64,iVBORw0KGgo=",
      "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'),
      "data:image/svg+xml,<svg><script>alert(1)</script></svg>",
      "data:image/svg+xml;base64," + btoa('<svg onload="alert(1)"></svg>'),
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
    ]) expect(safeWalletIcon(icon)).toBeNull();
    const info = sanitizeWalletInfo({ name: "Alpha Wallet", rdns: "io.example.alpha", uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", icon: "data:image/png;base64,iVBORw0KGgo=" });
    expect(info.icon).toBeNull();
    expect(info.initial).toBe("A");
    expect(info.warnings).toContain("icon-not-rendered");
    expect(sanitizeWalletInfo({ name: "x", rdns: "bad rdns", uuid: "not-a-uuid" }).warnings).toEqual(expect.arrayContaining(["invalid-uuid", "invalid-rdns"]));
  });
});

describe("explicit EIP-1193 connection and events", () => {
  test("requires explicit user initiation; connection does not happen on construction", async () => {
    const { session, provider } = sessionFixture();
    expect(session.snapshot().status).toBe("idle");
    expect(provider.provider.calls).toHaveLength(0);
    await expectCode(session.connect({}), WALLET_ERROR.EXPLICIT_ACTION_REQUIRED);
    expect(provider.provider.calls).toHaveLength(0);
    const state = await session.connect({ userInitiated: true });
    expect(state.status).toBe("connected");
    expect(state.account.toLowerCase()).toBe(TEST_PAYER.toLowerCase());
    expect(state.chainId).toBe(97);
    expect(provider.provider.calls.map((call) => call.method)).toEqual(["eth_requestAccounts", "eth_chainId"]);
    expect(provider.provider.calls[0].params).toEqual([]);
  });

  test("two providers stay separate; selecting B never calls A", async () => {
    const a = defaultProvider();
    const b = defaultProvider();
    const walletA = { info: walletInfo("Alpha", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), provider: a.provider };
    const walletB = { info: walletInfo("Beta", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), provider: b.provider };
    const { discovery } = discoveryFixture({ wallets: [walletA, walletB] });
    const entryB = discovery.list().find((entry) => entry.name === "Beta");
    const session = createExternalWallet({ discovery, selectionId: entryB.id, registry: registryFixture(), now: () => NOW });
    await session.connect({ userInitiated: true });
    expect(a.provider.calls).toHaveLength(0);
    expect(b.provider.calls.map((call) => call.method)).toEqual(["eth_requestAccounts", "eth_chainId"]);
    expect(session.snapshot().selection.name).toBe("Beta");
  });

  test("legacy selection is usable but still requires the explicit connect call", async () => {
    const legacy = defaultProvider();
    const { discovery } = discoveryFixture({ legacy: legacy.provider });
    const session = createExternalWallet({ discovery, selectionId: "legacy", registry: registryFixture(), now: () => NOW });
    expect(legacy.provider.calls).toHaveLength(0);
    await session.connect({ userInitiated: true });
    expect(legacy.provider.calls[0].method).toBe("eth_requestAccounts");
    expect(session.snapshot().selection.source).toBe("legacy");
  });

  test("maps 4001/4100/4900 and timeout without retrying", async () => {
    for (const [code, expected] of [[4001, WALLET_ERROR.USER_REJECTED], [4100, WALLET_ERROR.UNAUTHORIZED], [4900, WALLET_ERROR.DISCONNECTED]]) {
      const provider = defaultProvider({ eth_requestAccounts: async () => { throw Object.assign(new Error("wallet"), { code }); } });
      const { session } = sessionFixture({ provider });
      const calls = provider.provider.calls.length;
      await expectCode(session.connect({ userInitiated: true }), expected);
      expect(provider.provider.calls.length).toBe(calls + 1);
    }
    const provider = defaultProvider({ eth_requestAccounts: async () => new Promise(() => {}) });
    const { session } = sessionFixture({ provider, timeouts: { connectMs: 20 } });
    await expectCode(session.connect({ userInitiated: true }), WALLET_ERROR.WALLET_TIMEOUT);
    expect(provider.provider.calls).toHaveLength(1);
  });

  test("accountsChanged/chainChanged/disconnect invalidate old generations", async () => {
    const { session, provider } = await connectedFixture();
    const first = session.snapshot();
    expect(session.isCurrent(first.generation)).toBe(true);
    provider.provider.emit("chainChanged", "0x14a34");
    const second = session.snapshot();
    expect(second.chainId).toBe(84532);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(session.isCurrent(first.generation)).toBe(false);
    provider.provider.emit("accountsChanged", [TEST_STRANGER]);
    expect(session.snapshot().account.toLowerCase()).toBe(TEST_STRANGER.toLowerCase());
    expect(session.isCurrent(second.generation)).toBe(false);
    provider.provider.emit("disconnect", { code: 4900 });
    expect(session.snapshot().status).toBe("disconnected");
    expect(session.snapshot().account).toBeNull();
    await expectCode(session.signDeposit(depositDocument(), { userInitiated: true }), WALLET_ERROR.NOT_CONNECTED);
  });

  test("refresh uses eth_accounts, never eth_requestAccounts", async () => {
    const { session, provider } = await connectedFixture();
    provider.provider.calls.length = 0;
    await session.refresh();
    expect(provider.provider.calls.map((call) => call.method)).toEqual(["eth_accounts", "eth_chainId"]);
  });

  test("chain switch is explicit and never adds a chain or signs afterwards", async () => {
    const provider = defaultProvider();
    const switchCalls = [];
    provider.provider.request = ((original) => async (call) => {
      switchCalls.push(structuredClone(call));
      if (call.method === "wallet_switchEthereumChain") {
        provider.setChain(call.params[0].chainId);
        return null;
      }
      return original(call);
    })(provider.provider.request.bind(provider.provider));
    const { session } = await connectedFixture({ provider });
    await expectCode(session.requestSwitchChain(84532), WALLET_ERROR.EXPLICIT_ACTION_REQUIRED);
    expect(switchCalls.filter((call) => call.method === "wallet_switchEthereumChain")).toHaveLength(0);
    const switched = await session.requestSwitchChain(84532, { userInitiated: true });
    expect(switched.chainId).toBe(84532);
    expect(session.snapshot().chainId).toBe(84532);
    expect(switchCalls.filter((call) => call.method === "wallet_switchEthereumChain")).toHaveLength(1);
    expect(switchCalls.some((call) => call.method === "wallet_addEthereumChain")).toBe(false);
    expect(switchCalls.some((call) => call.method === "eth_signTypedData_v4")).toBe(false);
    expect(switchCalls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  test("chain switch refusals keep the current chain and never add the target", async () => {
    const provider = defaultProvider({ wallet_switchEthereumChain: async () => { throw Object.assign(new Error("no"), { code: 4901 }); } });
    const { session } = await connectedFixture({ provider });
    await expectCode(session.requestSwitchChain(84532, { userInitiated: true }), WALLET_ERROR.CHAIN_NOT_ADDED);
    expect(session.snapshot().chainId).toBe(97);
    expect(provider.provider.calls.some((call) => call.method === "wallet_addEthereumChain")).toBe(false);

    const rejecting = defaultProvider({ wallet_switchEthereumChain: async () => { throw Object.assign(new Error("no"), { code: 4001 }); } });
    const second = await connectedFixture({ provider: rejecting });
    await expectCode(second.session.requestSwitchChain(84532, { userInitiated: true }), WALLET_ERROR.USER_REJECTED);
    expect(second.session.snapshot().chainId).toBe(97);

    const mainnet = await connectedFixture();
    await expectCode(mainnet.session.requestSwitchChain(56, { userInitiated: true }), WALLET_ERROR.MAINNET_BLOCKED);
    expect(mainnet.session.snapshot().chainId).toBe(97);
  });
});

describe("EIP-712 signing: exact document, local recovery and invalidation", () => {
  test("signs exactly the verified typed data and recovers the selected account", async () => {
    const { session, provider } = await connectedFixture();
    const document = depositDocument();
    provider.provider.calls.length = 0;
    const result = await session.signDeposit(document, { userInitiated: true, expectedIntentHash: document.digest });
    expect(result.payerAddress.toLowerCase()).toBe(TEST_PAYER.toLowerCase());
    expect(result.digest).toBe(document.digest);
    expect(result.generation).toBe(session.snapshot().generation);
    const signCall = provider.provider.calls.find((call) => call.method === "eth_signTypedData_v4");
    expect(signCall.params).toEqual([TEST_PAYER, JSON.stringify(document.typedData)]);
    expect(provider.provider.calls.some((call) => call.method === "wallet_switchEthereumChain")).toBe(false);
    expect(provider.provider.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  test("requires explicit action and an explicit connection", async () => {
    const { session, provider } = await connectedFixture();
    const document = depositDocument();
    await expectCode(session.signDeposit(document, {}), WALLET_ERROR.EXPLICIT_ACTION_REQUIRED);
    expect(provider.provider.calls.some((call) => call.method === "eth_signTypedData_v4")).toBe(false);
    const fresh = sessionFixture().session;
    await expectCode(fresh.signDeposit(document, { userInitiated: true }), WALLET_ERROR.NOT_CONNECTED);
  });

  test("wrong chain is refused with instructions, never auto-switched", async () => {
    const { session, provider } = await connectedFixture();
    provider.setChain("0x14a34");
    provider.provider.emit("chainChanged", "0x14a34");
    await expectCode(session.signDeposit(depositDocument(), { userInitiated: true }), WALLET_ERROR.CHAIN_MISMATCH);
    expect(provider.provider.calls.some((call) => call.method === "wallet_switchEthereumChain")).toBe(false);
    expect(provider.provider.calls.some((call) => call.method === "eth_signTypedData_v4")).toBe(false);
  });

  test("maps rejection/lock/timeout and never returns a signature", async () => {
    for (const [code, expected] of [[4001, WALLET_ERROR.USER_REJECTED], [4100, WALLET_ERROR.UNAUTHORIZED], [4900, WALLET_ERROR.DISCONNECTED]]) {
      const provider = defaultProvider({ eth_signTypedData_v4: async () => { throw Object.assign(new Error("wallet"), { code }); } });
      const { session } = await connectedFixture({ provider });
      await expectCode(session.signDeposit(depositDocument(), { userInitiated: true }), expected);
      expect(provider.provider.calls.some((call) => call.method === "eth_signTypedData_v4")).toBe(true);
    }
    const provider = defaultProvider({ eth_signTypedData_v4: async () => new Promise(() => {}) });
    const { session } = await connectedFixture({ provider, timeouts: { signMs: 20 } });
    await expectCode(session.signDeposit(depositDocument(), { userInitiated: true }), WALLET_ERROR.WALLET_TIMEOUT);
    expect(provider.provider.calls.filter((call) => call.method === "eth_signTypedData_v4")).toHaveLength(1);
  });

  test("rejects a signature from another account", async () => {
    const provider = defaultProvider({ eth_signTypedData_v4: async (params) => signDigest(typedDataDigest(JSON.parse(params[1])), 2n) });
    const { session } = await connectedFixture({ provider });
    await expectCode(session.signDeposit(depositDocument(), { userInitiated: true }), WALLET_ERROR.INVALID_SIGNATURE);
  });

  test("discards signatures when the account or chain changes during signing", async () => {
    for (const event of ["accountsChanged", "chainChanged"]) {
      const provider = defaultProvider();
      const original = provider.provider.request.bind(provider.provider);
      provider.provider.request = async (call) => {
        if (call.method === "eth_signTypedData_v4") {
          if (event === "accountsChanged") provider.setAccounts([TEST_STRANGER]);
          else provider.setChain("0x14a34");
          provider.provider.emit(event, event === "accountsChanged" ? [TEST_STRANGER] : "0x14a34");
        }
        return original(call);
      };
      const { session } = await connectedFixture({ provider });
      await expectCode(session.signDeposit(depositDocument(), { userInitiated: true }), WALLET_ERROR.WALLET_STATE_CHANGED);
      expect(provider.provider.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
    }
  });

  test("unknown asset/issuer/disabled/not-creditable are always refused; the old bool bypass is gone", async () => {
    const { session, provider } = await connectedFixture();
    const unknown = depositDocument({ assetId: "eip155:97:0x" + "6".repeat(40), contractAddress: "0x" + "6".repeat(40) });
    provider.provider.calls.length = 0;
    await expectCode(session.signDeposit(unknown, { userInitiated: true }), WALLET_ERROR.UNKNOWN_TOKEN);
    // Kept in the options only to prove the former escape hatch no longer works.
    await expectCode(session.signDeposit(unknown, { userInitiated: true, allowUnregisteredAsset: true }), WALLET_ERROR.UNKNOWN_TOKEN);
    expect(provider.provider.calls.some((call) => call.method === "eth_signTypedData_v4")).toBe(false);

    const mystery = depositDocument({ assetId: "eip155:97:0x" + "8".repeat(40), contractAddress: "0x" + "8".repeat(40) });
    await expectCode(session.signDeposit(mystery, { userInitiated: true }), WALLET_ERROR.UNKNOWN_ISSUER);
    const disabled = depositDocument({ assetId: "eip155:97:0x" + "7".repeat(40), contractAddress: "0x" + "7".repeat(40) });
    await expectCode(session.signDeposit(disabled, { userInitiated: true }), WALLET_ERROR.UNKNOWN_TOKEN);
    const notCreditable = depositDocument({ assetId: "eip155:97:0x" + "a".repeat(40), contractAddress: "0x" + "a".repeat(40) });
    await expectCode(session.signDeposit(notCreditable, { userInitiated: true }), WALLET_ERROR.ASSET_NOT_CREDITABLE);
  });

  test("signing requires a local network registry; a missing registry is not an escape hatch", async () => {
    const noRegistry = sessionFixture({ registry: null });
    await noRegistry.session.connect({ userInitiated: true });
    const document = depositDocument({ assetId: "eip155:97:0x" + "6".repeat(40), contractAddress: "0x" + "6".repeat(40) });
    await expectCode(noRegistry.session.signDeposit(document, { userInitiated: true }), WALLET_ERROR.UNKNOWN_CHAIN);
    expect(noRegistry.provider.provider.calls.some((call) => call.method === "eth_signTypedData_v4")).toBe(false);
  });

  test("mainnet and malformed documents are refused before signing", async () => {
    const { session, provider } = await connectedFixture();
    const mainnet = depositDocument({ chainId: 56, contractAddress: CONTRACT });
    await expectCode(session.signDeposit(mainnet, { userInitiated: true }), WALLET_ERROR.MAINNET_BLOCKED);
    const digestBad = depositDocument();
    digestBad.typedData = { ...digestBad.typedData, message: { ...digestBad.typedData.message, recipient: "0x" + "4".repeat(40) } };
    await expectCode(session.signDeposit(digestBad, { userInitiated: true }), WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT);
    expect(provider.provider.calls.some((call) => call.method === "eth_signTypedData_v4")).toBe(false);
  });
});

describe("testnet ERC-20 preview, explicit send and receipts", () => {
  const transfer = { assetId: ASSET_97, amountRaw: "1000001", recipientAddress: RECIPIENT };

  test("previews exact token/native balances, gas, calldata and blockers without sending", async () => {
    const { session, provider } = await connectedFixture();
    provider.provider.calls.length = 0;
    const preview = await session.prepareTransfer({ userInitiated: true, ...transfer, intentHash: HASH });
    expect(preview.chainId).toBe(97);
    expect(preview.intentHash).toBe(HASH);
    expect(preview.calldataHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(preview.account.toLowerCase()).toBe(TEST_PAYER.toLowerCase());
    expect(preview.amountRaw).toBe("1000001");
    expect(preview.amountTokens).toBe("1.000001");
    expect(preview.tokenBalance).toBe("2");
    expect(preview.nativeBalance).toBe("1");
    expect(preview.gasLimitRaw).toBe("50000");
    expect(preview.gasPriceRaw).toBe("1000000000");
    expect(preview.estimatedFeeRaw).toBe("50000000000000");
    expect(preview.estimatedFeeNative).toBe("0.00005");
    expect(preview.feeModel).toBe("legacy-gas-price");
    expect(preview.canSend).toBe(true);
    expect(preview.blockers).toEqual([]);
    const expectedData = "0xa9059cbb" + RECIPIENT.toLowerCase().slice(2).padStart(64, "0") + BigInt("1000001").toString(16).padStart(64, "0");
    expect(preview.call.data).toBe(expectedData);
    expect(preview.call.to).toBe(CONTRACT);
    expect(preview.call.value).toBe("0x0");
    expect(provider.provider.calls.map((call) => call.method)).toEqual(["eth_accounts", "eth_chainId", "eth_call", "eth_getBalance", "eth_estimateGas", "eth_gasPrice"]);
    expect(provider.provider.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
    expect(provider.provider.calls[0].params).toEqual([]);
    await expectCode(session.prepareTransfer({ userInitiated: true, ...transfer, intentHash: "0x1234" }), WALLET_ERROR.INVALID_INTENT_HASH);
  });

  test("refuses to send without an injected Service operation journal; no provider call is made", async () => {
    const { session, provider } = await connectedFixture({ operationPort: null });
    const preview = await session.prepareTransfer({ userInitiated: true, ...transfer });
    provider.provider.calls.length = 0;
    await expectCode(session.confirmTransfer(preview, { userInitiated: true, acknowledged: true, previewId: preview.previewId }), WALLET_ERROR.OPERATION_JOURNAL_REQUIRED);
    expect(provider.provider.calls).toHaveLength(0);
    expect(preview.canSend).toBe(true);
  });

  test("reserves, marks broadcasting before send, and records the hash after", async () => {
    const port = memoryOperationPort();
    let duringSend = null;
    const provider = defaultProvider({ eth_sendTransaction: async () => {
      duringSend = { state: port.entry?.state, calls: port.calls.map((call) => call.name) };
      return TX_HASH;
    } });
    const { session } = await connectedFixture({ provider, operationPort: port });
    const preview = await session.prepareTransfer({ userInitiated: true, ...transfer, intentHash: HASH });
    const result = await session.confirmTransfer(preview, { userInitiated: true, acknowledged: true, previewId: preview.previewId });
    expect(result.transferVerified).toBe(false);
    expect(duringSend.state).toBe("broadcasting");
    expect(duringSend.calls).toEqual(["reserve", "markBroadcasting", "recordHash"] .slice(0, 2));
    expect(port.calls.map((call) => call.name)).toEqual(["reserve", "markBroadcasting", "recordHash"]);
    const operation = port.calls.find((call) => call.name === "reserve").operation;
    expect(operation).toMatchObject({
      schema: "ohmyaihub.external-wallet.operation/v1",
      intentHash: HASH,
      chainId: 97,
      assetId: ASSET_97,
      contractAddress: CONTRACT,
      recipientAddress: RECIPIENT,
      amountRaw: "1000001",
      calldataHash: preview.calldataHash,
      calldata: preview.call.data,
    });
    expect(operation.account.toLowerCase()).toBe(TEST_PAYER.toLowerCase());
    expect(operation.previewId).toBeUndefined();
    expect(port.entry.state).toBe("broadcast");
  });

  test("a journal that refuses markBroadcasting prevents the provider call", async () => {
    const port = memoryOperationPort();
    port.markBroadcasting = () => { throw new Error("journal down"); };
    const provider = defaultProvider();
    const { session } = await connectedFixture({ provider, operationPort: port });
    const preview = await session.prepareTransfer({ userInitiated: true, ...transfer });
    await expectCode(session.confirmTransfer(preview, { userInitiated: true, acknowledged: true, previewId: preview.previewId }), WALLET_ERROR.OPERATION_JOURNAL_FAILED);
    expect(provider.provider.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  test("an existing broadcasting journal entry blocks a new preview without sending", async () => {
    const port = memoryOperationPort();
    const provider = defaultProvider();
    const { session } = await connectedFixture({ provider, operationPort: port });
    const first = await session.prepareTransfer({ userInitiated: true, ...transfer, intentHash: HASH });
    const operation = {
      schema: "ohmyaihub.external-wallet.operation/v1", intentHash: HASH, account: first.account,
      chainId: first.chainId, assetId: first.assetId, contractAddress: first.contractAddress,
      recipientAddress: first.recipientAddress, amountRaw: first.amountRaw, calldata: first.call.data, calldataHash: first.calldataHash,
    };
    const reservation = port.reserve(operation);
    port.markBroadcasting({ reservationId: reservation.reservationId, operation });
    const second = await session.prepareTransfer({ userInitiated: true, ...transfer, intentHash: HASH });
    await expectCode(session.confirmTransfer(second, { userInitiated: true, acknowledged: true, previewId: second.previewId }), WALLET_ERROR.OPERATION_ALREADY_STARTED);
    expect(provider.provider.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  test("requires one explicit per-transfer confirmation and sends exactly the previewed call", async () => {
    const { session, provider } = await connectedFixture();
    const preview = await session.prepareTransfer({ userInitiated: true, ...transfer });
    provider.provider.calls.length = 0;
    await expectCode(session.confirmTransfer(preview, { userInitiated: true }), WALLET_ERROR.PREVIEW_CONFIRMATION_REQUIRED);
    await expectCode(session.confirmTransfer(preview, { userInitiated: true, acknowledged: true, previewId: "wrong" }), WALLET_ERROR.PREVIEW_CONFIRMATION_REQUIRED);
    expect(provider.provider.calls).toHaveLength(0);
    const result = await session.confirmTransfer(preview, { userInitiated: true, acknowledged: true, previewId: preview.previewId });
    expect(result.hash).toBe(TX_HASH);
    expect(result.broadcast).toBe(true);
    expect(result.credited).toBe(false);
    expect(result.finality).toBe("unknown");
    const send = provider.provider.calls.find((call) => call.method === "eth_sendTransaction");
    expect(send.params).toEqual([{
      from: TEST_PAYER, to: CONTRACT, value: "0x0", data: preview.call.data,
      gas: preview.gasLimitHex, gasPrice: preview.gasPriceHex,
    }]);
    expect(send.params[0].chainId).toBeUndefined();
    expect(send.params[0].nonce).toBeUndefined();
    expect(send.params[0].to).not.toBe("0x" + "d".repeat(40));
  });

  test("repeated and concurrent confirmation is idempotent: one send, same hash", async () => {
    const provider = defaultProvider({ eth_sendTransaction: async () => { await new Promise((resolve) => setTimeout(resolve, 25)); return TX_HASH; } });
    const { session } = await connectedFixture({ provider });
    const preview = await session.prepareTransfer({ userInitiated: true, ...transfer });
    const first = session.confirmTransfer(preview, { userInitiated: true, acknowledged: true, previewId: preview.previewId });
    const second = session.confirmTransfer(preview, { userInitiated: true, acknowledged: true, previewId: preview.previewId });
    const [a, b] = await Promise.all([first, second]);
    expect(a.hash).toBe(TX_HASH);
    expect(b.hash).toBe(TX_HASH);
    expect(provider.provider.calls.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(1);
    const again = await session.confirmTransfer(preview, { userInitiated: true, acknowledged: true, previewId: preview.previewId });
    expect(again.alreadySent).toBe(true);
    expect(again.credited).toBe(false);
    expect(provider.provider.calls.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(1);
  });

  test("insufficient balances are visible blockers, not fabricated zeroes or sends", async () => {
    const tokenPoor = defaultProvider();
    tokenPoor.setTokenBalance("0x0");
    const a = await connectedFixture({ provider: tokenPoor });
    const previewA = await a.session.prepareTransfer({ userInitiated: true, ...transfer });
    expect(previewA.canSend).toBe(false);
    expect(previewA.blockers).toContain("代币余额不足");
    expect(previewA.tokenBalance).toBe("0");
    await expectCode(a.session.confirmTransfer(previewA, { userInitiated: true, acknowledged: true, previewId: previewA.previewId }), WALLET_ERROR.PREVIEW_BLOCKED);
    expect(tokenPoor.provider.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);

    const nativePoor = defaultProvider();
    nativePoor.setNativeBalance("0x0");
    const b = await connectedFixture({ provider: nativePoor });
    const previewB = await b.session.prepareTransfer({ userInitiated: true, ...transfer });
    expect(previewB.canSend).toBe(false);
    expect(previewB.blockers).toContain("原生余额不足以支付 gas");
    await expectCode(b.session.confirmTransfer(previewB, { userInitiated: true, acknowledged: true, previewId: previewB.previewId }), WALLET_ERROR.PREVIEW_BLOCKED);
    expect(nativePoor.provider.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  test("mainnet 56/8453 previews, signatures and sends are refused before any broadcast", async () => {
    for (const chain of [56, 8453]) {
      const provider = defaultProvider({ eth_chainId: async () => "0x" + chain.toString(16) });
      const registry = registryFixture();
      if (chain === 8453) registry.networks.push({ chainId: 8453, displayName: "Base", family: "evm", networkType: "mainnet", enabled: false, support: "read-only", receivable: false, nativeSymbol: "ETH" });
      const { session } = await connectedFixture({ provider, registry });
      provider.provider.calls.length = 0;
      await expectCode(session.prepareTransfer({ userInitiated: true, ...transfer }), WALLET_ERROR.MAINNET_BLOCKED);
      expect(provider.provider.calls.some((call) => ["eth_call", "eth_estimateGas", "eth_sendTransaction"].includes(call.method))).toBe(false);
      const document = depositDocument({ chainId: chain, contractAddress: CONTRACT });
      await expectCode(session.signDeposit(document, { userInitiated: true }), WALLET_ERROR.MAINNET_BLOCKED);
      expect(provider.provider.calls.some((call) => call.method === "eth_signTypedData_v4")).toBe(false);
    }
  });

  test("mainnet read-only is opt-in and still cannot send", async () => {
    const provider = defaultProvider({ eth_chainId: async () => "0x38" });
    const { session } = await connectedFixture({ provider, allowMainnetRead: true });
    provider.provider.calls.length = 0;
    const balances = await session.readBalances();
    expect(balances.native.formatted).toBe("1");
    expect(balances.readOnly).toBe(true);
    expect(balances.creditEligible).toBe(false);
    expect(balances.usdValue).toBeNull();
    expect(provider.provider.calls.map((call) => call.method)).toEqual(["eth_accounts", "eth_chainId", "eth_getBalance"]);
    await expectCode(session.prepareTransfer({ userInitiated: true, ...transfer }), WALLET_ERROR.MAINNET_BLOCKED);
    expect(provider.provider.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  test("unknown chain/token/decimals/issuer/disabled assets are refused", async () => {
    const { session } = await connectedFixture();
    await expectCode(session.prepareTransfer({ userInitiated: true, assetId: "eip155:97:" + "6".repeat(40), amountRaw: "1", recipientAddress: RECIPIENT }), WALLET_ERROR.UNKNOWN_TOKEN);
    await expectCode(session.prepareTransfer({ userInitiated: true, assetId: "eip155:97:0x" + "9".repeat(40), amountRaw: "1", recipientAddress: RECIPIENT }), WALLET_ERROR.UNKNOWN_DECIMALS);
    await expectCode(session.prepareTransfer({ userInitiated: true, assetId: "eip155:97:0x" + "8".repeat(40), amountRaw: "1", recipientAddress: RECIPIENT }), WALLET_ERROR.UNKNOWN_ISSUER);
    await expectCode(session.prepareTransfer({ userInitiated: true, assetId: "eip155:97:0x" + "7".repeat(40), amountRaw: "1", recipientAddress: RECIPIENT }), WALLET_ERROR.UNKNOWN_TOKEN);
    await expectCode(session.prepareTransfer({ userInitiated: true, assetId: ASSET_84532, amountRaw: "1", recipientAddress: RECIPIENT }), WALLET_ERROR.UNKNOWN_TOKEN);
  });

  test("C-registry hard gates: forged testnet metadata cannot bypass chainId 56/8453", async () => {
    for (const chain of [56, 8453]) {
      const registry = registryFixture();
      if (!registry.networks.some((network) => network.chainId === chain)) registry.networks.push({ chainId: chain, displayName: "Mainnet", family: "evm", networkType: "mainnet", enabled: false, support: "read-only", receivable: false, nativeSymbol: "ETH" });
      registry.networks = registry.networks.map((network) => network.chainId === chain
        ? { ...network, networkType: "testnet", enabled: true, support: "credit", receivable: true }
        : network);
      const provider = defaultProvider({ eth_chainId: async () => "0x" + chain.toString(16) });
      const { session } = await connectedFixture({ provider, registry });
      provider.provider.calls.length = 0;
      await expectCode(session.prepareTransfer({ userInitiated: true, ...transfer }), WALLET_ERROR.MAINNET_BLOCKED);
      expect(provider.provider.calls.some((call) => ["eth_call", "eth_estimateGas", "eth_sendTransaction"].includes(call.method))).toBe(false);
      const document = depositDocument({ chainId: chain, contractAddress: CONTRACT });
      await expectCode(session.signDeposit(document, { userInitiated: true, allowUnregisteredAsset: true }), WALLET_ERROR.MAINNET_BLOCKED);
      expect(provider.provider.calls.some((call) => call.method === "eth_signTypedData_v4")).toBe(false);
    }
  });

  test("chain 1 forged as testnet and client-allowed is still denied for send/sign/switch", async () => {
    const chain1Contract = "0x" + "1".repeat(40);
    const chain1Asset = `eip155:1:${chain1Contract.toLowerCase()}`;
    const registry = registryFixture();
    registry.networks.push({ chainId: 1, displayName: "Ethereum", family: "evm", networkType: "testnet", enabled: true, support: "credit", receivable: true, nativeSymbol: "ETH" });
    registry.assets.push({ assetId: chain1Asset, chainId: 1, contractAddress: chain1Contract, symbol: "tONE", decimals: 6, issuerType: "mock", testnetOnly: true, enabled: true, credit: true, pricing: { kind: "fixed-test-rate" } });
    const provider = defaultProvider({ eth_chainId: async () => "0x1" });
    const { session } = await connectedFixture({ provider, registry, allowedChainIds: [1, 97, 84532] });
    provider.provider.calls.length = 0;
    await expectCode(session.prepareTransfer({ userInitiated: true, assetId: chain1Asset, amountRaw: "1", recipientAddress: RECIPIENT }), WALLET_ERROR.UNKNOWN_CHAIN);
    const document = depositDocument({ chainId: 1, contractAddress: chain1Contract });
    await expectCode(session.signDeposit(document, { userInitiated: true }), WALLET_ERROR.UNKNOWN_CHAIN);
    await expectCode(session.requestSwitchChain(1, { userInitiated: true }), WALLET_ERROR.UNKNOWN_CHAIN);
    expect(provider.provider.calls.some((call) => ["eth_sendTransaction", "eth_signTypedData_v4", "wallet_switchEthereumChain"].includes(call.method))).toBe(false);
    const balances = await session.readBalances({ assetId: chain1Asset });
    expect(balances.readOnly).toBe(true);
    expect(balances.creditEligible).toBe(false);
    expect(provider.provider.calls.some((call) => call.method === "wallet_switchEthereumChain")).toBe(false);
  });

  test("missing support/receivable or disabled credit network is not defaulted safe", async () => {
    const missingSupport = registryFixture();
    delete missingSupport.networks[0].support;
    const a = await connectedFixture({ registry: missingSupport });
    await expectCode(a.session.prepareTransfer({ userInitiated: true, ...transfer }), WALLET_ERROR.INVALID_REGISTRY);

    const missingReceivable = registryFixture();
    delete missingReceivable.networks[0].receivable;
    const b = await connectedFixture({ registry: missingReceivable });
    await expectCode(b.session.prepareTransfer({ userInitiated: true, ...transfer }), WALLET_ERROR.INVALID_REGISTRY);

    const disabled = registryFixture();
    disabled.networks[0].enabled = false;
    const c = await connectedFixture({ registry: disabled });
    await expectCode(c.session.prepareTransfer({ userInitiated: true, ...transfer }), WALLET_ERROR.CHAIN_DISABLED);
    await expectCode(c.session.signDeposit(depositDocument(), { userInitiated: true }), WALLET_ERROR.NETWORK_NOT_CREDITABLE);
  });

  test("accepts the page snapshot's pricingKind projection but never priceVersion guessing", async () => {
    const projected = registryFixture();
    delete projected.assets[0].pricing;
    projected.assets[0].pricingKind = "fixed-test-rate";
    const { session } = await connectedFixture({ registry: projected });
    const preview = await session.prepareTransfer({ userInitiated: true, ...transfer });
    expect(preview.canSend).toBe(true);
    const inconsistent = registryFixture();
    inconsistent.assets[0].pricingKind = "not-creditable";
    const b = await connectedFixture({ registry: inconsistent });
    await expectCode(b.session.prepareTransfer({ userInitiated: true, ...transfer }), WALLET_ERROR.INVALID_REGISTRY);
  });

  test("asset credit/pricing metadata is required for send and sign, not defaulted safe", async () => {
    const notCreditable = "eip155:97:0x" + "a".repeat(40);
    const { session } = await connectedFixture();
    await expectCode(session.prepareTransfer({ userInitiated: true, assetId: notCreditable, amountRaw: "1", recipientAddress: RECIPIENT }), WALLET_ERROR.ASSET_NOT_CREDITABLE);
    const document = depositDocument({ assetId: notCreditable, contractAddress: "0x" + "a".repeat(40) });
    await expectCode(session.signDeposit(document, { userInitiated: true }), WALLET_ERROR.ASSET_NOT_CREDITABLE);

    const missingCredit = registryFixture();
    delete missingCredit.assets[0].credit;
    const b = await connectedFixture({ registry: missingCredit });
    await expectCode(b.session.prepareTransfer({ userInitiated: true, ...transfer }), WALLET_ERROR.INVALID_REGISTRY);

    const missingPricing = registryFixture();
    delete missingPricing.assets[0].pricing;
    const c = await connectedFixture({ registry: missingPricing });
    await expectCode(c.session.prepareTransfer({ userInitiated: true, ...transfer }), WALLET_ERROR.INVALID_REGISTRY);
  });

  test("invalid recipient/amount and unknown user calldata fields are refused or ignored", async () => {
    const { session, provider } = await connectedFixture();
    await expectCode(session.prepareTransfer({ userInitiated: true, assetId: ASSET_97, amountRaw: "1", recipientAddress: "0x0" }), WALLET_ERROR.INVALID_ADDRESS);
    for (const amount of ["0", "-1", "01", "1.5", "1e3", ""]) await expectCode(session.prepareTransfer({ userInitiated: true, assetId: ASSET_97, amountRaw: amount, recipientAddress: RECIPIENT }), WALLET_ERROR.INVALID_AMOUNT);
    const preview = await session.prepareTransfer({ userInitiated: true, ...transfer, method: "eth_sendRawTransaction", data: "0xdead", to: "0x" + "d".repeat(40) });
    expect(preview.call.data.startsWith("0xa9059cbb")).toBe(true);
    expect(preview.call.data).not.toBe("0xdead");
    expect(preview.call.to).toBe(CONTRACT);
    expect(provider.provider.calls.some((call) => call.method === "eth_sendRawTransaction")).toBe(false);
  });

  test("account/chain/gas changes after preview invalidate it without sending", async () => {
    const chainChanged = await connectedFixture();
    const p1 = await chainChanged.session.prepareTransfer({ userInitiated: true, ...transfer });
    chainChanged.provider.provider.emit("chainChanged", "0x14a34");
    await expectCode(chainChanged.session.confirmTransfer(p1, { userInitiated: true, acknowledged: true, previewId: p1.previewId }), WALLET_ERROR.PREVIEW_STALE);
    expect(chainChanged.provider.provider.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);

    const accountChanged = await connectedFixture();
    const p2 = await accountChanged.session.prepareTransfer({ userInitiated: true, ...transfer });
    accountChanged.provider.provider.emit("accountsChanged", [TEST_STRANGER]);
    await expectCode(accountChanged.session.confirmTransfer(p2, { userInitiated: true, acknowledged: true, previewId: p2.previewId }), WALLET_ERROR.PREVIEW_STALE);
    expect(accountChanged.provider.provider.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);

    const gasChanged = await connectedFixture();
    const p3 = await gasChanged.session.prepareTransfer({ userInitiated: true, ...transfer });
    gasChanged.provider.setGasPrice("0x3b9aca01");
    await expectCode(gasChanged.session.confirmTransfer(p3, { userInitiated: true, acknowledged: true, previewId: p3.previewId }), WALLET_ERROR.PREVIEW_STALE);
    expect(gasChanged.provider.provider.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  test("send timeout/invalid hash become unknown, never automatic resend", async () => {
    const hanging = defaultProvider({ eth_sendTransaction: async () => new Promise(() => {}) });
    const a = await connectedFixture({ provider: hanging, timeouts: { sendMs: 20 } });
    const pa = await a.session.prepareTransfer({ userInitiated: true, ...transfer });
    await expectCode(a.session.confirmTransfer(pa, { userInitiated: true, acknowledged: true, previewId: pa.previewId }), WALLET_ERROR.WALLET_TIMEOUT);
    await expectCode(a.session.confirmTransfer(pa, { userInitiated: true, acknowledged: true, previewId: pa.previewId }), WALLET_ERROR.UNKNOWN_BROADCAST);
    expect(hanging.provider.calls.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(1);

    const badHash = defaultProvider({ eth_sendTransaction: async () => "0x1234" });
    const b = await connectedFixture({ provider: badHash });
    const pb = await b.session.prepareTransfer({ userInitiated: true, ...transfer });
    await expectCode(b.session.confirmTransfer(pb, { userInitiated: true, acknowledged: true, previewId: pb.previewId }), WALLET_ERROR.INVALID_TX_HASH);
    await expectCode(b.session.confirmTransfer(pb, { userInitiated: true, acknowledged: true, previewId: pb.previewId }), WALLET_ERROR.UNKNOWN_BROADCAST);
    expect(badHash.provider.calls.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(1);
  });

  test("user rejection is recorded unknown after broadcasting; no automatic or same-preview resend", async () => {
    const provider = defaultProvider({ eth_sendTransaction: async () => { throw Object.assign(new Error("rejected"), { code: 4001 }); } });
    const port = memoryOperationPort();
    const { session } = await connectedFixture({ provider, operationPort: port });
    const preview = await session.prepareTransfer({ userInitiated: true, ...transfer });
    await expectCode(session.confirmTransfer(preview, { userInitiated: true, acknowledged: true, previewId: preview.previewId }), WALLET_ERROR.USER_REJECTED);
    expect(provider.provider.calls.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(1);
    expect(port.entry.state).toBe("unknown");
    await expectCode(session.confirmTransfer(preview, { userInitiated: true, acknowledged: true, previewId: preview.previewId }), WALLET_ERROR.UNKNOWN_BROADCAST);
    expect(provider.provider.calls.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(1);
  });

  test("a fresh session sharing the journal does not resend an operation already marked unknown", async () => {
    const port = memoryOperationPort();
    const provider = defaultProvider({ eth_sendTransaction: async () => new Promise(() => {}) });
    const first = await connectedFixture({ provider, operationPort: port, timeouts: { sendMs: 20 } });
    const p1 = await first.session.prepareTransfer({ userInitiated: true, ...transfer, intentHash: HASH });
    await expectCode(first.session.confirmTransfer(p1, { userInitiated: true, acknowledged: true, previewId: p1.previewId }), WALLET_ERROR.WALLET_TIMEOUT);
    expect(port.entry.state).toBe("unknown");

    const second = await connectedFixture({ provider, operationPort: port, timeouts: { sendMs: 20 } });
    const p2 = await second.session.prepareTransfer({ userInitiated: true, ...transfer, intentHash: HASH });
    const error = await expectCode(second.session.confirmTransfer(p2, { userInitiated: true, acknowledged: true, previewId: p2.previewId }), WALLET_ERROR.OPERATION_UNKNOWN);
    expect(error.hash).toBeNull();
    expect(provider.provider.calls.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(1);
  });

  test("receipt status is evidence only; broadcast is never credit and RPC errors are not resent", async () => {
    const provider = defaultProvider();
    const { session } = await connectedFixture({ provider });
    provider.setReceipt(null);
    expect((await session.getReceipt(TX_HASH)).state).toBe("pending");
    provider.setReceipt({ transactionHash: TX_HASH, status: "0x1", blockNumber: "0x10" });
    const success = await session.getReceipt(TX_HASH);
    expect(success).toMatchObject({ state: "success", executionStatus: "success", paymentStatus: "unverified", credited: false, transferVerified: false, evidence: "chain-receipt", finality: "unknown", blockNumber: "0x10" });
    provider.setReceipt({ transactionHash: TX_HASH, status: "0x0", blockNumber: "0x11" });
    expect((await session.getReceipt(TX_HASH)).state).toBe("reverted");
    provider.setReceipt({ transactionHash: TX_HASH, status: "0x2", blockNumber: "0x12" });
    expect((await session.getReceipt(TX_HASH)).state).toBe("unknown");
    provider.setReceipt({ transactionHash: "0x" + "e".repeat(64), status: "0x1" });
    await expectCode(session.getReceipt(TX_HASH), WALLET_ERROR.RECEIPT_MISMATCH);
    provider.setReceipt(null);
    const before = provider.provider.calls.length;
    await expectCode(session.getReceipt("0x1234"), WALLET_ERROR.INVALID_TX_HASH);
    expect(provider.provider.calls.length).toBe(before);
    expect(provider.provider.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  test("malformed RPC data is RPC_UNKNOWN and never triggers a send", async () => {
    const provider = defaultProvider({ eth_call: async () => "0xzz" });
    const { session } = await connectedFixture({ provider });
    await expectCode(session.prepareTransfer({ userInitiated: true, ...transfer }), WALLET_ERROR.RPC_UNKNOWN);
    expect(provider.provider.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  test("balances distinguish native and registered token values", async () => {
    const { session, provider } = await connectedFixture();
    const balances = await session.readBalances({ assetId: ASSET_97 });
    expect(balances.native).toMatchObject({ symbol: "tBNB", decimals: 18, formatted: "1" });
    expect(balances.token).toMatchObject({ symbol: "tMOCK6", decimals: 6, formatted: "2" });
    expect(balances.readOnly).toBe(false);
    expect(balances.creditEligible).toBe(true);
    expect(balances.usdValue).toBeNull();
    await expectCode(session.readBalances({ assetId: "eip155:97:" + "6".repeat(40) }), WALLET_ERROR.UNKNOWN_TOKEN);
    provider.provider.calls.length = 0;
    await expectCode(session.readBalances({ assetId: ASSET_84532 }), WALLET_ERROR.CHAIN_MISMATCH);
    expect(provider.provider.calls.some((call) => call.method === "wallet_switchEthereumChain")).toBe(false);
  });
});

describe("API surface and no persistence", () => {
  test("session has no generic request/method passthrough and only fixed RPC methods appear", async () => {
    const { session } = sessionFixture();
    expect(Object.keys(session).sort()).toEqual([
      "confirmTransfer", "connect", "dispose", "getReceipt", "isCurrent", "prepareTransfer",
      "readBalances", "refresh", "requestSwitchChain", "signDeposit", "snapshot", "subscribe",
    ]);
    expect(typeof session.request).toBe("undefined");
    const source = readFileSync(new URL("./external-wallet.js", import.meta.url), "utf8");
    const methods = [...new Set(source.match(/\b(?:eth|wallet)_[A-Za-z0-9_]+/g) ?? [])].sort();
    expect(methods).toEqual([
      "eth_accounts", "eth_call", "eth_chainId", "eth_estimateGas", "eth_gasPrice",
      "eth_getBalance", "eth_getTransactionReceipt", "eth_requestAccounts", "eth_sendTransaction",
      "eth_signTypedData_v4", "wallet_switchEthereumChain",
    ]);
    for (const forbidden of ["eth_signTransaction", "eth_sendRawTransaction", "wallet_addEthereumChain", "wallet_watchAsset", "wallet_requestPermissions"]) {
      expect(source.includes(forbidden)).toBe(false);
    }
    expect(/\beth_sign\b/.test(source)).toBe(false);
  });

  test("module has no browser persistence or cookie access", () => {
    const source = readFileSync(new URL("./external-wallet.js", import.meta.url), "utf8");
    for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie", "window.name"]) expect(source.includes(forbidden)).toBe(false);
    expect(TESTNET_CHAIN_IDS).toEqual([97, 84532]);
    expect(MAINNET_CHAIN_IDS).toEqual([56, 8453]);
    expect(isMainnetChainId(56)).toBe(true);
    expect(isMainnetChainId(8453)).toBe(true);
    expect(isMainnetChainId(97)).toBe(false);
    expect(() => assertNoMainnetSend(56)).toThrow();
    expect(() => assertNoMainnetSend(97)).not.toThrow();
  });

  test("dispose removes listeners and clears the provider/account in memory", async () => {
    const { session, provider } = await connectedFixture();
    expect(provider.provider.listenerCount("accountsChanged")).toBeGreaterThan(0);
    session.dispose();
    const state = session.snapshot();
    expect(state.status).toBe("disposed");
    expect(state.account).toBeNull();
    expect(state.accounts).toEqual([]);
    expect(provider.provider.listenerCount("accountsChanged")).toBe(0);
    await expectCode(session.connect({ userInitiated: true }), WALLET_ERROR.DISPOSED);
  });
});
