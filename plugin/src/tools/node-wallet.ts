// The node wallet: one ethers key, one EVM address, no HD accounts.
//
// The key lives in `<stateDir>/wallet/key.hex` with mode 0600. Tools may return
// the address and balances; they never return the key. Import/export exist
// because a user may want to move the identity to another machine or back it up,
// and both only ever return the address (and, for export, the path).
//
// Chain facts (RPC endpoints, USDC contract, decimals) live in `chain.ts`. This
// module only reads balances through that registry's client, so there is no
// second copy of a contract address in the codebase.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Wallet as EthersWallet, formatUnits } from "ethers";
import { PRODUCT_CHAINS, clientFor, type ChainRecord } from "../chain.ts";
import { stateDir, statePath } from "../paths.ts";

export interface WalletChainReady {
  chain: "bsc" | "base";
  chainId: number;
  usdcRaw: string;
  usdcUsd: string;
  nativeRaw: string;
  gasOk: boolean;
}

export interface WalletChainUnavailable {
  chain: "bsc" | "base";
  chainId: number;
  status: "unavailable";
  detail: string;
}

export type WalletChain = WalletChainReady | WalletChainUnavailable;

export interface WalletBalance {
  address: string;
  chains: WalletChain[];
}

export interface ImportResult {
  address: string;
  changed: boolean;
  /** Internal only. Tool results never include this object. */
  wallet: EthersWallet;
}

export function walletFilePath(): string {
  return statePath("wallet", "key.hex");
}

function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 240) || "unknown error";
}

function parsePrivateKey(text: string, source: string): EthersWallet {
  const value = text.trim();
  const match = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(value);
  if (!match) throw new Error(`E_PATH: ${source} is not a 32-byte hex private key`);
  try {
    return new EthersWallet(`0x${match[1]}`);
  } catch {
    throw new Error(`E_PATH: ${source} is not a valid private key`);
  }
}

function writeKey(path: string, privateKey: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, `${privateKey}\n`, { mode: 0o600 });
  // The creation mode is already 0600; chmod is a second guarantee, and is
  // best-effort where the platform does not implement POSIX modes.
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows */
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows */
  }
}

/** Reads the key from disk, or null when no file exists. Throws on a bad file. */
export function loadWallet(): EthersWallet | null {
  const path = walletFilePath();
  if (!existsSync(path)) return null;
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`E_NO_WALLET: cannot read ${path}: ${shortError(error)}`);
  }
  const wallet = parsePrivateKey(body, path);
  if (process.platform !== "win32") {
    try {
      const mode = statSync(path).mode & 0o777;
      if (mode !== 0o600) chmodSync(path, 0o600);
    } catch (error) {
      throw new Error(`E_PATH: cannot secure ${path} to 0600: ${shortError(error)}`);
    }
  }
  return wallet;
}

/** Boot path: create the key on first start, then always return it. */
export function loadOrCreateWallet(): EthersWallet {
  const existing = loadWallet();
  if (existing) return existing;
  const generated = EthersWallet.createRandom();
  // HDNodeWallet's private field makes it a distinct nominal type; the node
  // wallet only needs the plain key pair.
  const wallet = new EthersWallet(generated.privateKey);
  writeKey(walletFilePath(), wallet.privateKey);
  return wallet;
}

export function importWallet(path: string, force = false): ImportResult {
  if (!isAbsolute(path)) throw new Error("E_PATH: wallet_import path must be absolute");
  if (!existsSync(path)) throw new Error(`E_PATH: ${path} does not exist`);

  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`E_PATH: cannot read ${path}: ${shortError(error)}`);
  }
  const incoming = parsePrivateKey(body, path);

  let existing: EthersWallet | null = null;
  try {
    existing = loadWallet();
  } catch {
    // A corrupt wallet file must not make recovery impossible.
    existing = null;
  }

  if (existing && existing.address.toLowerCase() !== incoming.address.toLowerCase()) {
    if (!force) {
      throw new Error(
        `E_WALLET_EXISTS: this node already has wallet ${existing.address}; ` +
          `pass force:true to replace it with ${incoming.address}`,
      );
    }
  }

  if (existing && existing.address.toLowerCase() === incoming.address.toLowerCase()) {
    return { address: existing.address, changed: false, wallet: existing };
  }

  writeKey(walletFilePath(), incoming.privateKey);
  return { address: incoming.address, changed: true, wallet: incoming };
}

function realish(value: string): string {
  try {
    if (existsSync(value)) return realpathSync(value);
    const parent = dirname(value);
    if (existsSync(parent)) return join(realpathSync(parent), basename(value));
  } catch {
    /* fall back to the lexical path */
  }
  return resolve(value);
}

function inside(root: string, target: string): boolean {
  const norm = (value: string) =>
    process.platform === "darwin" || process.platform === "win32" ? value.toLowerCase() : value;
  // macOS stateDir often lives under /var while the caller passed /private/var.
  // Compare real paths so a symlinked prefix cannot smuggle the key inside.
  const rel = relative(norm(realish(root)), norm(realish(target)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function exportWallet(path: string, overwrite = false): { address: string; path: string } {
  if (!isAbsolute(path)) throw new Error("E_PATH: wallet_export path must be absolute");
  if (inside(stateDir(), path)) {
    throw new Error("E_PATH: refusing to export the private key inside the plugin data directory");
  }
  const wallet = loadWallet();
  if (!wallet) throw new Error("E_NO_WALLET: this node has no wallet yet");
  if (existsSync(path) && !overwrite) {
    throw new Error(`E_PATH: ${path} already exists; pass overwrite:true to replace it`);
  }
  try {
    writeKey(path, wallet.privateKey);
  } catch (error) {
    throw new Error(`E_PATH: cannot write ${path}: ${shortError(error)}`);
  }
  return { address: wallet.address, path };
}

async function readChain(spec: ChainRecord, address: string): Promise<WalletChain> {
  try {
    // Same client as the watcher: ordered endpoints, sticky failover, no cached
    // head. A single dead public RPC must not turn a balance into "unavailable".
    const client = clientFor(spec, { timeoutMs: 8_000, rounds: 1 });
    const [native, usdc] = await Promise.all([
      client.balance(address),
      client.erc20Balance(spec.usdc, address),
    ]);
    return {
      chain: spec.key as WalletChainReady["chain"],
      chainId: spec.chainId,
      usdcRaw: usdc.toString(),
      usdcUsd: formatUnits(usdc, spec.decimals),
      nativeRaw: native.toString(),
      gasOk: native > 0n,
    };
  } catch (error) {
    return {
      chain: spec.key as WalletChainUnavailable["chain"],
      chainId: spec.chainId,
      status: "unavailable",
      detail: shortError(error),
    };
  }
}

/** Read-only balances. One chain failing never fails the whole call. */
export async function walletBalances(address: string): Promise<WalletBalance> {
  const chains = await Promise.all(PRODUCT_CHAINS.map((spec) => readChain(spec, address)));
  return { address, chains };
}
