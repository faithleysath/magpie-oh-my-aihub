// Read-only chain balances, including the real mainnets.
//
// This module can read; it cannot write. It has no signer, no transaction, no
// `eth_sendRawTransaction`, no cap and no ledger. A balance is returned as raw
// base units with an explicit `creditEligible: false` and `usdValue: null`, so a
// later UI cannot accidentally present a mainnet balance as spendable credit.
//
// The query is registry-driven and strict:
//
//   1. the chain must be registered and readable (`support: "read-only"` or an
//      enabled testnet);
//   2. `eth_chainId` must equal the registry chain id, so a BSC endpoint cannot
//      answer for Base;
//   3. for a token, the asset must be in the allowlist and its on-chain
//      `decimals()` and `symbol()` must match the recorded quadruple. An unknown
//      contract is refused before a balance is read;
//   4. native balances use `eth_getBalance` and are never assigned a USD value.
//
// No official RPC endpoint is special-cased. The reader takes the registry's
// endpoint list and uses `EvmClient`, which already verifies the chain id.

import { EvmClient, type EvmClientOptions } from "./evm.ts";
import type { AssetRecord, NetworkRecord, NetworkRegistry } from "./networks.ts";
import { formatTokenAmount } from "./walletamount.ts";

export const BALANCE_OF_SELECTOR = "0x70a08231";
export const SYMBOL_SELECTOR = "0x95d89b41";
export const DECIMALS_SELECTOR = "0x313ce567";

export interface ReadOnlyBalanceInput {
  chainId: number;
  address: string;
  /** omitted or null means the native coin */
  assetId?: string | null;
}

export interface ReadOnlyAssetView {
  assetId: string;
  contractAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  issuerType: string;
  credit: false;
}

export interface ReadOnlyBalance {
  schema: "ohmyaihub.readonly-balance/v1";
  chainId: number;
  displayName: string;
  networkType: string;
  blockExplorer: string;
  address: string;
  /** null for the native coin */
  asset: ReadOnlyAssetView | null;
  nativeSymbol: string;
  balanceRaw: string;
  decimals: number;
  balanceTokens: string;
  blockNumber: number;
  readOnly: true;
  /** a mainnet balance is never spendable credit in this build */
  creditEligible: false;
  /** no rate is defined for a mainnet, so no USD value is invented */
  usdValue: null;
  note: string;
  observedAt: string;
}

export interface ReadOnlyChainSummary {
  chainId: number;
  displayName: string;
  networkType: string;
  support: string;
  receivable: boolean;
  nativeSymbol: string;
  rpcConfigured: boolean;
  blockExplorer: string;
  note: string;
}

export interface ReadOnlyReaderDeps {
  registry: NetworkRegistry;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** injected in tests; production uses `new EvmClient` over the registry endpoints */
  clientFactory?: (opts: EvmClientOptions) => EvmClient;
}

function assertAddress(address: unknown): string {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("a balance address must be a 20-byte hex address");
  if (/^0x0{40}$/i.test(address)) throw new Error("the zero address cannot be queried as a wallet");
  return address;
}

/** An ABI word (32 bytes) from `eth_call`; short replies are refused. */
function word(hex: unknown, label: string): bigint {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error(`${label} returned no hex quantity`);
  if (hex.length < 66) throw new Error(`${label} returned a short word`);
  return BigInt(`0x${hex.slice(2, 66)}`);
}

/** A JSON-RPC quantity (`eth_getBalance`), which is not zero-padded. */
function quantity(hex: unknown, label: string): bigint {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error(`${label} returned no hex quantity`);
  return BigInt(hex);
}

/** Strict ABI string decoder for `symbol()`; a malformed answer is refused, not guessed. */
function abiString(hex: unknown, label: string): string {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/.test(hex)) throw new Error(`${label} returned no ABI data`);
  const body = hex.slice(2);
  if (body.length < 128) throw new Error(`${label} returned a short ABI string`);
  const offset = Number(BigInt(`0x${body.slice(0, 64)}`)) * 2;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 64 > body.length) throw new Error(`${label} has an invalid string offset`);
  const length = Number(BigInt(`0x${body.slice(offset, offset + 64)}`)) * 2;
  if (!Number.isSafeInteger(length) || length < 0 || length > 512 || offset + 64 + length > body.length) {
    throw new Error(`${label} has an invalid string length`);
  }
  const data = body.slice(offset + 64, offset + 64 + length);
  const bytes = new Uint8Array(data.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(data.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

/** `balanceOf(address)` calldata, with the address in the single 32-byte word. */
export function encodeBalanceOf(address: string): string {
  return `${BALANCE_OF_SELECTOR}${assertAddress(address).slice(2).toLowerCase().padStart(64, "0")}`;
}

/**
 * A read-only reader. Constructing it does not touch the network; `balance()`
 * performs exactly one chain-id check and the calls needed for one balance.
 */
export class ReadOnlyChainReader {
  private readonly registry: NetworkRegistry;
  private readonly fetchImpl?: typeof fetch;
  private readonly now: () => Date;
  private readonly clientFactory: (opts: EvmClientOptions) => EvmClient;

  constructor(deps: ReadOnlyReaderDeps) {
    this.registry = deps.registry;
    this.fetchImpl = deps.fetchImpl;
    this.now = deps.now ?? (() => new Date());
    this.clientFactory = deps.clientFactory ?? ((opts) => new EvmClient(opts));
  }

  /** The read-only product networks (BSC/Base). No RPC is made. */
  networks(): ReadOnlyChainSummary[] {
    return this.registry.readOnlyNetworks().map((n) => ({
      chainId: n.chainId,
      displayName: n.displayName,
      networkType: n.networkType,
      support: n.support,
      receivable: n.receivable,
      nativeSymbol: n.nativeSymbol,
      rpcConfigured: n.rpcEndpoints.length > 0,
      blockExplorer: n.blockExplorer,
      note: n.support === "read-only" ? "Read-only: balance can be read; no credit, send or auto-recharge." : "Testnet credit path.",
    }));
  }

  private client(net: NetworkRecord): EvmClient {
    const opts: EvmClientOptions = {
      chainId: net.chainId,
      endpoints: net.rpcEndpoints,
      fetchImpl: this.fetchImpl,
      now: () => this.now().getTime(),
    };
    return this.clientFactory(opts);
  }

  /**
   * Reads one native or allowlisted-token balance. Every refusal happens before
   * a number is returned; there is no "best effort" shape.
   */
  async balance(input: ReadOnlyBalanceInput): Promise<ReadOnlyBalance> {
    const address = assertAddress(input.address);
    const net = this.registry.requireReadableNetwork(input.chainId);
    if (net.support !== "read-only") {
      throw new Error(`chain ${net.chainId} is a testnet/credit network; this reader is for read-only product networks only`);
    }
    const asset: AssetRecord | null = input.assetId ? this.registry.requireReadableAsset(input.assetId) : null;
    if (asset && asset.chainId !== net.chainId) {
      throw new Error(`asset ${asset.assetId} belongs to chain ${asset.chainId}, not ${net.chainId}`);
    }
    const client = this.client(net);
    await client.verifyChain();
    const blockNumber = await client.blockNumber();
    let balanceRaw: bigint;
    let decimals: number;
    let assetView: ReadOnlyAssetView | null = null;

    if (asset) {
      const onchainDecimals = word(await client.callData(asset.contractAddress, DECIMALS_SELECTOR), `${asset.symbol} decimals()`);
      if (onchainDecimals !== BigInt(asset.decimals)) {
        throw new Error(
          `${asset.contractAddress} reports ${onchainDecimals} decimals on chain ${net.chainId}, not the registered ${asset.decimals}; refusing to read a balance`,
        );
      }
      const onchainSymbol = abiString(await client.callData(asset.contractAddress, SYMBOL_SELECTOR), `${asset.symbol} symbol()`);
      if (onchainSymbol.toLowerCase() !== asset.symbol.toLowerCase()) {
        throw new Error(
          `${asset.contractAddress} reports symbol ${JSON.stringify(onchainSymbol)} on chain ${net.chainId}, not the registered ${asset.symbol}; refusing to read a balance`,
        );
      }
      balanceRaw = word(await client.callData(asset.contractAddress, encodeBalanceOf(address)), `${asset.symbol} balanceOf()`);
      decimals = asset.decimals;
      assetView = {
        assetId: asset.assetId,
        contractAddress: asset.contractAddress,
        symbol: asset.symbol,
        name: asset.name,
        decimals: asset.decimals,
        issuerType: asset.issuerType,
        credit: false,
      };
    } else {
      balanceRaw = quantity(await client.call<string>("eth_getBalance", [address, "latest"]), "eth_getBalance");
      decimals = net.nativeDecimals;
      assetView = null;
    }

    return {
      schema: "ohmyaihub.readonly-balance/v1",
      chainId: net.chainId,
      displayName: net.displayName,
      networkType: net.networkType,
      blockExplorer: net.blockExplorer,
      address,
      asset: assetView,
      nativeSymbol: net.nativeSymbol,
      balanceRaw: balanceRaw.toString(),
      decimals,
      balanceTokens: formatTokenAmount(balanceRaw.toString(), decimals),
      blockNumber,
      readOnly: true,
      creditEligible: false,
      usdValue: null,
      note:
        net.networkType === "mainnet"
          ? "Read-only mainnet balance. This build cannot send, credit or automatically recharge a mainnet; no USD value is computed."
          : "Read-only balance on a testnet. This query does not credit anything.",
      observedAt: this.now().toISOString(),
    };
  }
}
