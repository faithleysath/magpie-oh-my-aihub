// Narrow local-console adapter for the approved C read-only/receiving core.
//
// This module owns only presentation and input validation. It deliberately has
// no RPC client, registry, policy, store or ledger of its own: it asks the
// Service for the fixed Wallet (whose registry/reader/policy are internal) and
// exposes no way for a caller to pass a store, RPC endpoint or provider id.
//
// Ordinary state polls are local-only. Only an explicit balance-refresh action
// performs a read-only RPC, using the already-approved ReadOnlyChainReader.

import { ConsoleInputError } from "./console-server.ts";
import type { Service } from "./service.ts";
import type { Wallet } from "./wallet.ts";
import type { AssetRecord, NetworkRecord } from "./networks.ts";

const PRODUCT_CHAIN_IDS = [56, 8453] as const;
const BALANCE_TTL_MS = 5 * 60 * 1000;
const WATCH_LIMIT = 32;

export const NETWORK_LOCAL_ACTIONS = [
  "network-local-state",
  "network-local-watch-address",
  "network-local-receiving-set",
  "network-local-balance-refresh",
] as const;

export interface NetworkLocalNetwork {
  chainId: number;
  displayName: string;
  networkType: string;
  support: string;
  receivable: boolean;
  nativeSymbol: string;
  nativeDecimals: number;
  blockExplorer: string;
}

export interface NetworkLocalAsset {
  assetId: string;
  chainId: number;
  contractAddress: string;
  symbol: string;
  decimals: number;
  issuerType: string;
  testnetOnly: boolean;
  credit: boolean;
  pricingKind: string;
}

export interface NetworkLocalBalanceOk {
  schema: "ohmyaihub.network-local-balance/v1";
  state: "ok";
  chainId: number;
  address: string;
  asset: { assetId: string; contractAddress: string; symbol: string; decimals: number; issuerType: string } | null;
  nativeSymbol: string;
  balanceRaw: string;
  decimals: number;
  balanceTokens: string;
  blockNumber: number;
  addressSource: "watch";
  readOnly: true;
  creditEligible: false;
  usdValue: null;
  observedAt: string;
  expiresAt: string;
  fresh: boolean;
  stale: boolean;
  needsRefresh: boolean;
}

export interface NetworkLocalBalanceUnknown {
  schema: "ohmyaihub.network-local-balance/v1";
  state: "unknown";
  chainId: number;
  address: string;
  assetId: string | null;
  addressSource: "watch";
  readOnly: true;
  creditEligible: false;
  usdValue: null;
  errorCode: "balance_unavailable";
  observedAt: string;
  expiresAt: string;
  fresh: boolean;
  stale: boolean;
  needsRefresh: boolean;
}

export type NetworkLocalBalance = NetworkLocalBalanceOk | NetworkLocalBalanceUnknown;

export interface NetworkLocalState {
  schema: "ohmyaihub.network-local/v1";
  at: string;
  available: boolean;
  configured: boolean;
  reason: string | null;
  product: { networks: NetworkLocalNetwork[]; assets: NetworkLocalAsset[] };
  receiving: {
    providerId: string | null;
    chainIds: number[];
    updatedAt: string | null;
    /** false means [] is not a user empty selection; it is unavailable */
    available: boolean;
    errorCode: "not_configured" | "receiving_selection_unreadable" | "wallet_unavailable" | null;
  };
  watchAddresses: string[];
  lastBalance: NetworkLocalBalance | null;
  readOnly: true;
  creditEligible: false;
  usdValue: null;
}

function refuse(message: string): never {
  throw new ConsoleInputError(message);
}

function onlyFields(input: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) refuse("unexpected action parameter");
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) refuse(`${label} must be a positive integer`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") refuse(`${label} must be true or false`);
  return value;
}

function walletAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    refuse("address must be a non-zero 20-byte hex address");
  }
  return value.toLowerCase();
}

function productNetworks(wallet: Wallet): NetworkRecord[] {
  return wallet
    .productNetworks()
    .filter((n) => (PRODUCT_CHAIN_IDS as readonly number[]).includes(n.chainId) && n.networkType === "mainnet" && n.support === "read-only");
}

function productNetwork(wallet: Wallet, chainId: number): NetworkRecord {
  const network = productNetworks(wallet).find((n) => n.chainId === chainId);
  if (!network) refuse(`chain ${chainId} is not an exact product read-only network`);
  return network;
}

function approvedAsset(wallet: Wallet, chainId: number, assetId: string): AssetRecord {
  const asset = wallet.registryView().asset(assetId);
  if (!asset || !asset.enabled || asset.chainId !== chainId || asset.credit || asset.testnetOnly) {
    refuse(`asset ${assetId} is not an approved read-only asset on chain ${chainId}`);
  }
  if (wallet.registryView().network(chainId)?.support !== "read-only") refuse(`chain ${chainId} is not read-only`);
  return asset;
}

class NetworkLocalAdapter {
  private watchAddresses = new Set<string>();
  private lastBalance: NetworkLocalBalance | null = null;

  constructor(private readonly service: Service) {}

  private wallet(): Wallet | null {
    const candidate = this.service as unknown as { walletForConfiguration?: unknown; config?: unknown };
    if (typeof candidate.walletForConfiguration !== "function" || typeof candidate.config !== "function") return null;
    try {
      return this.service.walletForConfiguration();
    } catch {
      return null;
    }
  }

  private providerId(): string | null {
    try {
      return this.service.config()?.nodeId ?? null;
    } catch {
      return null;
    }
  }

  state(): NetworkLocalState {
    const at = new Date().toISOString();
    const base: NetworkLocalState = {
      schema: "ohmyaihub.network-local/v1",
      at,
      available: false,
      configured: false,
      reason: "wallet_unavailable",
      product: { networks: [], assets: [] },
      receiving: { providerId: null, chainIds: [], updatedAt: null, available: false, errorCode: "wallet_unavailable" },
      watchAddresses: [...this.watchAddresses].sort(),
      lastBalance: this.lastBalance ? this.withFreshness(this.lastBalance) : null,
      readOnly: true,
      creditEligible: false,
      usdValue: null,
    };
    const wallet = this.wallet();
    if (!wallet) return base;
    const providerId = this.providerId();
    let receiving: NetworkLocalState["receiving"] = {
      providerId,
      chainIds: [],
      updatedAt: null,
      available: false,
      errorCode: providerId ? "receiving_selection_unreadable" : "not_configured",
    };
    if (providerId) {
      try {
        const selection = wallet.receivingSelection(providerId);
        receiving = { providerId, chainIds: selection.chainIds, updatedAt: selection.updatedAt, available: true, errorCode: null };
      } catch {
        // The core policy deliberately fails closed on a corrupt/invalid file.
        // Project that as an error, not as a user empty selection, and never let
        // the whole console state poll fail.
        receiving = { providerId, chainIds: [], updatedAt: null, available: false, errorCode: "receiving_selection_unreadable" };
      }
    }
    return {
      ...base,
      available: true,
      configured: Boolean(providerId),
      reason: null,
      product: {
        networks: productNetworks(wallet).map((n) => ({
          chainId: n.chainId,
          displayName: n.displayName,
          networkType: n.networkType,
          support: n.support,
          receivable: n.receivable,
          nativeSymbol: n.nativeSymbol,
          nativeDecimals: n.nativeDecimals,
          blockExplorer: n.blockExplorer,
        })),
        assets: productNetworks(wallet).flatMap((n) =>
          wallet
            .registryView()
            .assetsForChain(n.chainId)
            .filter((a) => a.enabled && !a.credit && !a.testnetOnly)
            .map((a) => ({
              assetId: a.assetId,
              chainId: a.chainId,
              contractAddress: a.contractAddress,
              symbol: a.symbol,
              decimals: a.decimals,
              issuerType: a.issuerType,
              testnetOnly: a.testnetOnly,
              credit: a.credit,
              pricingKind: a.pricing.kind,
            })),
        ),
      },
      receiving,
      lastBalance: this.lastBalance ? this.withFreshness(this.lastBalance) : null,
    };
  }

  private project(balance: Awaited<ReturnType<Wallet["readOnlyBalance"]>>): NetworkLocalBalanceOk {
    return {
      schema: "ohmyaihub.network-local-balance/v1",
      state: "ok",
      chainId: balance.chainId,
      address: balance.address,
      asset: balance.asset
        ? {
            assetId: balance.asset.assetId,
            contractAddress: balance.asset.contractAddress,
            symbol: balance.asset.symbol,
            decimals: balance.asset.decimals,
            issuerType: balance.asset.issuerType,
          }
        : null,
      nativeSymbol: balance.nativeSymbol,
      balanceRaw: balance.balanceRaw,
      decimals: balance.decimals,
      balanceTokens: balance.balanceTokens,
      blockNumber: balance.blockNumber,
      addressSource: "watch",
      readOnly: true,
      creditEligible: false,
      usdValue: null,
      observedAt: balance.observedAt,
      expiresAt: new Date(Date.parse(balance.observedAt) + BALANCE_TTL_MS).toISOString(),
      fresh: true,
      stale: false,
      needsRefresh: false,
    };
  }

  private withFreshness(balance: NetworkLocalBalance): NetworkLocalBalance {
    const fresh = Date.now() < Date.parse(balance.expiresAt);
    return { ...balance, fresh, stale: !fresh, needsRefresh: !fresh };
  }

  private unknown(chainId: number, address: string, assetId: string | null): NetworkLocalBalanceUnknown {
    return {
      schema: "ohmyaihub.network-local-balance/v1",
      state: "unknown",
      chainId,
      address,
      assetId,
      addressSource: "watch",
      readOnly: true,
      creditEligible: false,
      usdValue: null,
      errorCode: "balance_unavailable",
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + BALANCE_TTL_MS).toISOString(),
      fresh: true,
      stale: false,
      needsRefresh: false,
    };
  }

  async action(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "network-local-state":
        onlyFields(input, []);
        return this.state();
      case "network-local-watch-address": {
        onlyFields(input, ["address"]);
        const address = walletAddress(input.address);
        if (!this.watchAddresses.has(address) && this.watchAddresses.size >= WATCH_LIMIT) {
          refuse(`watch list is full (${WATCH_LIMIT}); remove or restart the local session before adding another address`);
        }
        this.watchAddresses.add(address);
        return this.state();
      }
      case "network-local-receiving-set": {
        onlyFields(input, ["chainId", "selected"]);
        const chainId = integer(input.chainId, "chainId");
        const selected = boolean(input.selected, "selected");
        const wallet = this.wallet();
        const providerId = this.providerId();
        if (!wallet) refuse("the local wallet is unavailable");
        if (!providerId) refuse("configure this node first");
        try {
          wallet.setReceivingNetwork(providerId, chainId, selected);
        } catch (e) {
          refuse(String((e as Error)?.message ?? e));
        }
        return this.state();
      }
      case "network-local-balance-refresh": {
        onlyFields(input, ["chainId", "address", "assetId", "addressSource"]);
        const chainId = integer(input.chainId, "chainId");
        const address = walletAddress(input.address);
        if (input.addressSource !== "watch") refuse("addressSource must be watch; no implicit wallet/unlocked address is accepted");
        if (!this.watchAddresses.has(address)) refuse("address is not an explicitly watched local address");
        const wallet = this.wallet();
        if (!wallet) refuse("the local wallet is unavailable");
        productNetwork(wallet, chainId);
        let assetId: string | null = null;
        if (input.assetId !== undefined && input.assetId !== null) {
          if (typeof input.assetId !== "string" || input.assetId.length > 160) refuse("assetId is invalid");
          assetId = input.assetId;
          approvedAsset(wallet, chainId, assetId);
        }
        try {
          const balance = await wallet.readOnlyBalance({ chainId, address, assetId });
          this.lastBalance = this.project(balance);
        } catch {
          // Unknown RPC/read-only failure is never projected as zero.
          this.lastBalance = this.unknown(chainId, address, assetId);
        }
        return { balance: this.lastBalance };
      }
      default:
        return refuse("unsupported network-local action");
    }
  }
}

const owners = new WeakMap<Service, NetworkLocalAdapter>();
function owner(service: Service): NetworkLocalAdapter {
  let value = owners.get(service);
  if (!value) {
    value = new NetworkLocalAdapter(service);
    owners.set(service, value);
  }
  return value;
}

export function consoleNetworkState(service: Service): NetworkLocalState {
  return owner(service).state();
}

export async function consoleNetworkAction(service: Service, name: string, input: Record<string, unknown>): Promise<unknown> {
  return owner(service).action(name, input);
}
