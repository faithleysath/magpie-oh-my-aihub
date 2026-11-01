// The built-in wallet's local vault: BIP39/BIP44 keys, a standard Web3
// keystore-v3 file, a short unlocked session, and deliberately narrow signing.
//
// This module is an experimental, local-only capability. It is not a custody
// service and it does not make a self-custody wallet safe on a shared Bun host:
// any code in the same process can read the decrypted key while the session is
// unlocked, and JavaScript cannot promise that a key is erased from memory.
// The production rule remains: a built-in wallet must not hold real assets.
//
// Format choices, on purpose:
//  - The mnemonic is generated/validated by `ethers` (BIP39, English wordlist).
//  - The EVM account is derived at the standard `m/44'/60'/0'/0/0` path.
//  - The file is a Web3 Secret Storage v3 keystore written by `ethers`. Its
//    `x-ethers` extension stores the BIP39 entropy encrypted in the same file,
//    so the vault survives a restart and can export the mnemonic later.
//  - The password KDF is scrypt with pinned, bounded parameters. A keystore
//    with a weak or absurd KDF is refused before it can consume memory.
//  - No browser storage, no plaintext key file, no custom cipher envelope.
//
// Sensitive exports and signatures are two different things:
//  - `exportMnemonic`/`exportPrivateKey` need an active session, a fresh
//    password verification, and a one-shot local capability minted by
//    `createExportCapability`. The capability object cannot be forged or
//    serialized, and is consumed even when the password is wrong.
//  - Signing needs an active session and a one-shot/bounded `SigningPermit`.
//    There is no raw `sign(hash)` API and no background auto-sign path.
//  - Mainnet chain ids 56 and 8453 are hard-denied for every signature. Other
//    mainnet/unknown chains are denied by the injected chain policy; EIP-712
//    documents for them can be *previewed* only.

import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import {
  HDNodeWallet,
  Mnemonic,
  Transaction,
  TypedDataEncoder,
  Wallet,
  encryptKeystoreJson,
  getAddress,
  isAddress,
  keccak256,
  randomBytes as ethersRandomBytes,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";

/** The standard BIP44 path used for the built-in EVM account. */
export const BIP44_EVM_PATH = "m/44'/60'/0'/0/0";

/** Chain ids that may never be signed or sent by this experimental wallet. */
export const MAINNET_SIGNING_DENIED_CHAIN_IDS: readonly number[] = Object.freeze([56, 8453]);

/**
 * The only chains the built-in signer may use in normal operation. This is an
 * allowlist, not a mainnet blacklist: chain 1/10/42161/... and unknown ids are
 * denied even when an injected WalletChainPolicy lies and calls them testnet.
 */
const SIGNING_CHAIN_ALLOWLIST_INTERNAL = new Set<number>([97, 84532]);
/**
 * Public view for tests/diagnostics. Mutating this copy cannot change the
 * internal signing gate; the vault reads SIGNING_CHAIN_ALLOWLIST_INTERNAL only.
 */
export const SIGNING_CHAIN_ALLOWLIST: ReadonlySet<number> = new Set(SIGNING_CHAIN_ALLOWLIST_INTERNAL);

/** 31337 is available only through the explicit isolated test option below. */
export const ISOLATED_SIMULATION_CHAIN_ALLOWLIST: readonly number[] = Object.freeze([31337]);

export const WALLET_VAULT_VERSION = 1;
export const DEFAULT_SESSION_TTL_MS = 5 * 60_000;
export const MAX_SESSION_TTL_MS = 15 * 60_000;
export const DEFAULT_EXPORT_CAPABILITY_TTL_MS = 60_000;
export const MAX_EXPORT_CAPABILITY_TTL_MS = 120_000;
export const DEFAULT_SIGNING_PERMIT_TTL_MS = 60_000;
export const MAX_SIGNING_PERMIT_TTL_MS = 5 * 60_000;
export const MAX_SIGNING_PERMIT_USES = 8;
export const MAX_AUTO_RECHARGE_TTL_MS = 5 * 60_000;
export const MAX_KEYSTORE_BYTES = 128 * 1024;
export const MAX_PAYMENT_DATA_BYTES = 16 * 1024;
const UINT256_MAX = (1n << 256n) - 1n;
const ETHERS_CLIENT_RE = /^ethers\/(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;
const GETH_FILENAME_RE = /^UTC--\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d+Z--[0-9a-fA-F]{40}$/;

export interface WalletKdfParams {
  /** scrypt N; must be a power of two in [MIN_KDF_N, MAX_KDF_N] */
  N: number;
  r: number;
  p: number;
}

export const MIN_KDF_N = 1 << 15;
export const MAX_KDF_N = 1 << 18;
export const MAX_KDF_MEMORY_BYTES = 256 * 1024 * 1024;

/** Defaults are intentionally strong for a local wallet; tests may pin smaller bounded values. */
export const DEFAULT_KDF: WalletKdfParams = Object.freeze({ N: 1 << 17, r: 8, p: 1 });

export type WalletStatus = "absent" | "locked" | "unlocked";
export type WalletChainClass = "simulation" | "testnet" | "mainnet" | "unknown";

/** The registry owns chain identification; the vault only asks whether a chain may sign. */
export interface WalletChainPolicy {
  classify(chainId: number): WalletChainClass;
}

/** Safe default: no chain may sign until a service wires the real registry policy. */
export const DENY_ALL_CHAIN_POLICY: WalletChainPolicy = Object.freeze({
  classify: () => "unknown" as const,
});

export function createStaticChainPolicy(
  entries: Readonly<Record<number, "simulation" | "testnet">>,
): WalletChainPolicy {
  const map = new Map<number, "simulation" | "testnet">();
  const supported = new Map<number, "simulation" | "testnet">([
    [97, "testnet"],
    [84532, "testnet"],
    [31337, "simulation"],
  ]);
  for (const [raw, value] of Object.entries(entries)) {
    const chainId = Number(raw);
    const expected = supported.get(chainId);
    if (!expected) {
      throw new WalletVaultError("config-invalid", "chain policy only supports the explicit test/simulation allowlist");
    }
    if (value !== expected) {
      throw new WalletVaultError("config-invalid", "chain policy class does not match the supported chain");
    }
    map.set(chainId, value);
  }
  return Object.freeze({ classify: (chainId: number) => map.get(chainId) ?? "unknown" });
}

export type WalletVaultErrorCode =
  | "wallet-absent"
  | "wallet-exists"
  | "wallet-locked"
  | "wallet-session-expired"
  | "wallet-io"
  | "wallet-file-permissions"
  | "wallet-file-too-large"
  | "password-policy"
  | "password-invalid"
  | "mnemonic-invalid"
  | "keystore-invalid"
  | "keystore-weak-kdf"
  | "keystore-dos"
  | "config-invalid"
  | "export-capability-invalid"
  | "export-capability-expired"
  | "export-capability-used"
  | "export-purpose-mismatch"
  | "signing-disabled"
  | "signing-mainnet-forbidden"
  | "signing-purpose-invalid"
  | "signing-permit-invalid"
  | "signing-permit-expired"
  | "signing-permit-exhausted"
  | "signing-permit-limit"
  | "prepared-invalid"
  | "typed-data-invalid"
  | "payment-invalid"
  | "auto-recharge-invalid";

export class WalletVaultError extends Error {
  readonly code: WalletVaultErrorCode;
  readonly detail: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: WalletVaultErrorCode,
    message: string,
    detail: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message);
    this.name = "WalletVaultError";
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

function fail(
  code: WalletVaultErrorCode,
  message: string,
  detail: Readonly<Record<string, string | number | boolean>> = {},
): never {
  throw new WalletVaultError(code, message, detail);
}

export interface WalletSnapshot {
  readonly version: typeof WALLET_VAULT_VERSION;
  /**
   * The keystore's public address. It is NOT a trusted receiving address until
   * `addressVerified` is true; locked snapshots must not be used for payment
   * targets, QR codes or transfer instructions.
   */
  readonly address: string | null;
  /** True only while unlocked after the decrypted address/private key checks. */
  readonly addressVerified: boolean;
  readonly status: WalletStatus;
  /** Absolute session expiry, only while unlocked. */
  readonly unlockExpiresAt: string | null;
}

export interface WalletVaultOptions {
  /** A dedicated file path, normally `<state-dir>/wallet/keystore.json`. */
  path: string;
  now?: () => number;
  sessionTtlMs?: number;
  /** Override only for tests/experiments; production should use DEFAULT_KDF. */
  kdf?: Partial<WalletKdfParams>;
  chainPolicy?: WalletChainPolicy;
  purposes?: readonly WalletTypedDataPurpose[];
  /**
   * Test-only isolated local chain ids. Only 31337 is accepted. Normal UI/config
   * must never derive this from networkType or a user-editable setting.
   */
  isolatedSimulationChains?: readonly number[];
}

interface ResolvedVaultOptions {
  path: string;
  now: () => number;
  sessionTtlMs: number;
  kdf: WalletKdfParams;
  chainPolicy: WalletChainPolicy;
  purposes: ReadonlyMap<string, WalletTypedDataPurpose>;
  allowedSigningChains: ReadonlyMap<number, "testnet" | "simulation">;
}

export interface CreateWalletResult {
  readonly snapshot: WalletSnapshot;
  /** Shown once by the caller; never stored in the vault response/snapshot. */
  readonly mnemonic: string;
  readonly path: string;
}

export interface ImportMnemonicInput {
  mnemonic: string;
  password: string;
  replace?: boolean;
  /** Required to overwrite an existing vault; re-verifies the old password. */
  currentPassword?: string;
}

export interface RestoreBackupInput {
  keystore: string;
  password: string;
  replace?: boolean;
  /** Required to overwrite an existing vault; re-verifies the old password. */
  currentPassword?: string;
}

export interface EncryptedBackup {
  readonly format: "web3-keystore-v3";
  readonly address: string;
  readonly keystore: string;
}

export type SensitiveExportKind = "mnemonic" | "private-key";
export type SensitiveExportPurpose =
  | "wallet-recovery"
  | "wallet-migration"
  | "eip155-external-wallet";

export interface MnemonicExport {
  readonly kind: "mnemonic";
  readonly purpose: SensitiveExportPurpose;
  readonly address: string;
  readonly path: string;
  readonly mnemonic: string;
  readonly warning: string;
}

export interface PrivateKeyExport {
  readonly kind: "private-key";
  readonly purpose: SensitiveExportPurpose;
  readonly address: string;
  readonly path: string;
  readonly privateKey: string;
  readonly warning: string;
}

export interface ExportCapabilityInput {
  kind: SensitiveExportKind;
  purpose: SensitiveExportPurpose;
  /** A literal local confirmation, not a network/request field. */
  confirmation: "local-user-confirmed";
  ttlMs?: number;
}

const CAPABILITY_BRAND = Symbol("wallet-export-capability");
const PERMIT_BRAND = Symbol("wallet-signing-permit");

interface CapabilityRecord {
  vaultId: string;
  sessionId: string;
  kind: SensitiveExportKind;
  purpose: SensitiveExportPurpose;
  expiresAt: number;
  used: boolean;
}

const capabilityRecords = new WeakMap<SensitiveExportCapability, CapabilityRecord>();

/**
 * A one-shot, non-serializable local authorization for one sensitive export.
 * It binds the current vault session and export kind/purpose. Possessing it is
 * not enough: the export also re-checks the wallet password.
 */
export class SensitiveExportCapability {
  constructor(brand: symbol) {
    if (brand !== CAPABILITY_BRAND) {
      throw new WalletVaultError("export-capability-invalid", "export capabilities are minted only by the vault");
    }
  }

  get kind(): SensitiveExportKind {
    return recordOfCapability(this).kind;
  }

  get purpose(): SensitiveExportPurpose {
    return recordOfCapability(this).purpose;
  }

  get expiresAt(): string {
    return new Date(recordOfCapability(this).expiresAt).toISOString();
  }

  toJSON(): undefined {
    return undefined;
  }

  toString(): string {
    return "[SensitiveExportCapability]";
  }
}

function recordOfCapability(value: SensitiveExportCapability): CapabilityRecord {
  const record = capabilityRecords.get(value);
  if (!record) fail("export-capability-invalid", "unknown export capability");
  return record;
}

function mintExportCapability(record: Omit<CapabilityRecord, "used">): SensitiveExportCapability {
  const value = new SensitiveExportCapability(CAPABILITY_BRAND);
  capabilityRecords.set(value, { ...record, used: false });
  return Object.freeze(value);
}

function exportCapabilityRecord(value: SensitiveExportCapability): CapabilityRecord | null {
  return capabilityRecords.get(value) ?? null;
}

export type SigningPermitKind = "typed-data" | "payment";
export type PaymentPurpose = "payment" | "auto-recharge";

/**
 * A permit binds the exact prepared intent (typed-data digest or a payment
 * intent hash), not just a chain and a purpose. This is what stops a P2P caller
 * from swapping the recipient, calldata, value or typed-data document after
 * the local user confirmed one preview.
 */
export type SigningPermitInput =
  | {
      kind: "typed-data";
      prepared: PreparedTypedData;
      maxUses?: number;
      ttlMs?: number;
    }
  | {
      kind: "payment";
      purpose: PaymentPurpose;
      prepared: PreparedPayment;
      maxUses?: number;
      ttlMs?: number;
      /** Optional defense-in-depth limits; they may not be below the prepared value. */
      maxPerPaymentWei?: bigint;
      maxTotalWei?: bigint;
    };

interface PermitRecord {
  vaultId: string;
  sessionId: string;
  kind: SigningPermitKind;
  purpose: string;
  chainId: number;
  bindingHash: string;
  expiresAt: number;
  maxUses: number;
  used: number;
  maxPerPaymentWei: bigint | null;
  maxTotalWei: bigint | null;
  spentWei: bigint;
}

const permitRecords = new WeakMap<SigningPermit, PermitRecord>();

/**
 * A short, bounded permission to sign. It is not a wallet key and cannot be
 * serialized. The future auto-recharge executor (not implemented here) must
 * create one of these after a user opt-in and must never mint one from P2P data.
 */
export class SigningPermit {
  constructor(brand: symbol) {
    if (brand !== PERMIT_BRAND) {
      throw new WalletVaultError("signing-permit-invalid", "signing permits are minted only by the vault");
    }
  }

  get kind(): SigningPermitKind {
    return recordOfPermit(this).kind;
  }

  get purpose(): string {
    return recordOfPermit(this).purpose;
  }

  get chainId(): number {
    return recordOfPermit(this).chainId;
  }

  get expiresAt(): string {
    return new Date(recordOfPermit(this).expiresAt).toISOString();
  }

  get maxUses(): number {
    return recordOfPermit(this).maxUses;
  }

  get remainingUses(): number {
    const r = recordOfPermit(this);
    return Math.max(0, r.maxUses - r.used);
  }

  toJSON(): undefined {
    return undefined;
  }

  toString(): string {
    return "[SigningPermit]";
  }
}

function recordOfPermit(value: SigningPermit): PermitRecord {
  const record = permitRecords.get(value);
  if (!record) fail("signing-permit-invalid", "unknown signing permit");
  return record;
}

function mintSigningPermit(record: PermitRecord): SigningPermit {
  const value = new SigningPermit(PERMIT_BRAND);
  permitRecords.set(value, record);
  return Object.freeze(value);
}

function signingPermitRecord(value: SigningPermit): PermitRecord | null {
  return permitRecords.get(value) ?? null;
}

export interface WalletTypedDataPurpose {
  readonly id: string;
  readonly chainId: number;
  readonly primaryType: string;
  readonly domainName: string;
  readonly domainVersion: string;
  readonly verifyingContracts: readonly string[];
  /** Field order is the EIP-712 declaration order. Only primitive types are allowed. */
  readonly messageTypes: Readonly<Record<string, string>>;
}

export interface WalletTypedData {
  readonly domain: TypedDataDomain;
  readonly types: Readonly<Record<string, readonly TypedDataField[]>>;
  readonly primaryType: string;
  readonly message: Readonly<Record<string, unknown>>;
}

export interface PrepareTypedDataInput {
  purpose: string;
  typedData: WalletTypedData;
}

export interface PreparedTypedData {
  readonly purpose: string;
  readonly chainId: number;
  readonly primaryType: string;
  readonly verifyingContract: string;
  readonly digest: string;
  readonly signable: true;
}

interface PreparedTypedDataRecord {
  vaultId: string;
  typedData: WalletTypedData;
  digest: string;
  purpose: WalletTypedDataPurpose;
}

const preparedTypedDataRecords = new WeakMap<PreparedTypedData, PreparedTypedDataRecord>();

export interface TypedDataPreview {
  readonly digest: string;
  readonly chainId: number | null;
  readonly primaryType: string;
  readonly typedData: WalletTypedData;
  /** Always false: preview never signs, including for mainnet 56/8453. */
  readonly signable: false;
  readonly reason: "preview-only";
}

export interface PaymentRequestInput {
  chainId: number;
  to: string;
  valueWei: bigint;
  data?: string;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface PreparedPayment {
  readonly from: string;
  readonly chainId: number;
  readonly to: string;
  /** native transfer (value > 0) or an exact ERC-20 transfer (value 0, data) */
  readonly kind: "native" | "erc20";
  readonly tokenAddress: string | null;
  readonly tokenAmountRaw: string | null;
  readonly tokenDecimals: number | null;
  readonly valueWei: string;
  readonly nonce: number;
  readonly gasLimit: string;
  readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
  /** gasLimit * maxFeePerGas, the worst-case gas spend. */
  readonly maxGasCostWei: string;
  /** valueWei + maxGasCostWei, the worst-case total spend. */
  readonly maxCostWei: string;
  readonly data: string;
  readonly signable: true;
}

interface PreparedPaymentRecord {
  vaultId: string;
  transaction: {
    type: 2;
    chainId: number;
    to: string;
    value: bigint;
    data: string;
    nonce: number;
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  };
  prepared: PreparedPayment;
}

const preparedPaymentRecords = new WeakMap<PreparedPayment, PreparedPaymentRecord>();

export interface SignedTypedData {
  readonly signature: string;
  readonly digest: string;
  readonly address: string;
  readonly chainId: number;
  readonly purpose: string;
  readonly primaryType: string;
  readonly verifyingContract: string;
}

export interface SignedPayment {
  readonly rawTransaction: string;
  readonly hash: string;
  readonly from: string;
  readonly to: string;
  readonly chainId: number;
  readonly valueWei: string;
  readonly maxGasCostWei: string;
  readonly maxCostWei: string;
  readonly nonce: number;
  readonly purpose: PaymentPurpose;
  /** A signed payload has not been broadcast and is not a payment proof. */
  readonly broadcast: false;
}

/**
 * The narrow interface a P2P/transport adapter may hold. It can read the public
 * snapshot, prepare a document, and sign only when the local UI has already
 * minted a bound `SigningPermit`. It deliberately exposes no unlock, export,
 * backup, password or permit-minting operation. This is an API boundary, not a
 * sandbox against arbitrary code in the shared Bun process.
 */
export interface WalletSigningFacade {
  snapshot(): WalletSnapshot;
  prepareTypedData(input: PrepareTypedDataInput): PreparedTypedData;
  preparePayment(input: PaymentRequestInput): PreparedPayment;
  signTypedData(input: { prepared: PreparedTypedData; permit: SigningPermit }): SignedTypedData;
  signPayment(input: { prepared: PreparedPayment; permit: SigningPermit }): Promise<SignedPayment>;
}

export interface AutoRechargePolicy {
  readonly version: 1;
  readonly chainId: number;
  readonly assetId: string;
  readonly maxPerPaymentWei: bigint;
  readonly maxTotalWei: bigint;
  readonly maxPayments: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly belowBalanceWei?: bigint;
  readonly targetBalanceWei?: bigint;
}

interface ParsedKeystore {
  readonly text: string;
  readonly address: string;
  readonly kdf: WalletKdfParams;
  readonly mnemonicEntropyBytes: number;
}

interface Session {
  readonly id: string;
  readonly wallet: HDNodeWallet;
  readonly expiresAt: number;
  readonly address: string;
}

export class WalletVault {
  private readonly options: ResolvedVaultOptions;
  private readonly vaultId: string;
  private publicAddress: string | null = null;
  private session: Session | null = null;
  private queue: Promise<void> = Promise.resolve();

  private constructor(options: ResolvedVaultOptions) {
    this.options = options;
    this.vaultId = nodeRandomBytes(16).toString("hex");
  }

  static async open(options: WalletVaultOptions): Promise<WalletVault> {
    const vault = new WalletVault(resolveOptions(options));
    await vault.reloadPublicAddress();
    return vault;
  }

  get path(): string {
    return this.options.path;
  }

  /**
   * A narrow capability for service/P2P integration. The returned object cannot
   * unlock, export, change the password, or mint permits. Keep the full vault
   * object inside the local UI/service boundary.
   */
  signingFacade(): WalletSigningFacade {
    const vault = this;
    return Object.freeze({
      snapshot: () => vault.snapshot(),
      prepareTypedData: (input: PrepareTypedDataInput) => vault.prepareTypedData(input),
      preparePayment: (input: PaymentRequestInput) => vault.preparePayment(input),
      signTypedData: (input: { prepared: PreparedTypedData; permit: SigningPermit }) => vault.signTypedData(input),
      signPayment: (input: { prepared: PreparedPayment; permit: SigningPermit }) => vault.signPayment(input),
    });
  }

  snapshot(): WalletSnapshot {
    this.expireSessionIfNeeded();
    const session = this.session;
    const addressVerified =
      session !== null && this.publicAddress !== null && session.address === this.publicAddress;
    return Object.freeze({
      version: WALLET_VAULT_VERSION,
      address: this.publicAddress,
      addressVerified,
      status: this.publicAddress === null ? "absent" : session ? "unlocked" : "locked",
      unlockExpiresAt: session ? new Date(session.expiresAt).toISOString() : null,
    });
  }

  lock(): void {
    this.lockInternal();
  }

  dispose(): void {
    this.lockInternal();
  }

  async create(input: {
    password: string;
    strength?: 128 | 160 | 192 | 224 | 256;
    replace?: boolean;
    /** Required to overwrite an existing vault; re-verifies the old password. */
    currentPassword?: string;
  }): Promise<CreateWalletResult> {
    assertNewPassword(input.password);
    const strength = input.strength ?? 128;
    if (![128, 160, 192, 224, 256].includes(strength)) {
      fail("config-invalid", "mnemonic strength must be 128/160/192/224/256 bits");
    }
    return this.serial(async () => {
      await this.assertCanReplace(input.replace === true, input.currentPassword);
      this.lockInternal();
      const mnemonic = Mnemonic.fromEntropy(ethersRandomBytes(strength / 8));
      const wallet = HDNodeWallet.fromMnemonic(mnemonic, BIP44_EVM_PATH);
      await this.persist(wallet, input.password, input.replace === true);
      return Object.freeze({
        snapshot: this.snapshot(),
        mnemonic: mnemonic.phrase,
        path: BIP44_EVM_PATH,
      });
    });
  }

  async importMnemonic(input: ImportMnemonicInput): Promise<WalletSnapshot> {
    assertNewPassword(input.password);
    const phrase = normalizeMnemonic(input.mnemonic);
    return this.serial(async () => {
      await this.assertCanReplace(input.replace === true, input.currentPassword);
      this.lockInternal();
      const mnemonic = parseMnemonic(phrase);
      const wallet = HDNodeWallet.fromMnemonic(mnemonic, BIP44_EVM_PATH);
      await this.persist(wallet, input.password, input.replace === true);
      return this.snapshot();
    });
  }

  async restore(input: RestoreBackupInput): Promise<WalletSnapshot> {
    assertNewPassword(input.password);
    if (
      typeof input.keystore !== "string" ||
      input.keystore.length > MAX_KEYSTORE_BYTES ||
      byteLength(input.keystore) > MAX_KEYSTORE_BYTES
    ) {
      fail("keystore-invalid", "encrypted backup is missing or too large");
    }
    return this.serial(async () => {
      await this.assertCanReplace(input.replace === true, input.currentPassword);
      this.lockInternal();
      const parsed = validateKeystore(input.keystore);
      const wallet = await decryptWallet(parsed, input.password);
      await this.persist(wallet, input.password, input.replace === true);
      return this.snapshot();
    });
  }

  async unlock(password: string): Promise<WalletSnapshot> {
    assertPasswordInput(password);
    return this.serial(async () => {
      const parsed = await this.readKeystoreOrThrow();
      this.lockInternal();
      const wallet = await decryptWallet(parsed, password);
      this.session = {
        id: nodeRandomBytes(16).toString("hex"),
        wallet,
        address: wallet.address,
        expiresAt: this.currentTime() + this.options.sessionTtlMs,
      };
      this.publicAddress = wallet.address;
      return this.snapshot();
    });
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<WalletSnapshot> {
    assertPasswordInput(currentPassword);
    assertNewPassword(newPassword);
    return this.serial(async () => {
      this.lockInternal();
      const parsed = await this.readKeystoreOrThrow();
      const wallet = await decryptWallet(parsed, currentPassword);
      await this.persist(wallet, newPassword, true);
      return this.snapshot();
    });
  }

  async exportEncryptedBackup(): Promise<EncryptedBackup> {
    return this.serial(async () => {
      this.assertSession();
      const parsed = await this.readKeystoreOrThrow();
      return Object.freeze({
        format: "web3-keystore-v3" as const,
        address: parsed.address,
        keystore: parsed.text,
      });
    });
  }

  createExportCapability(input: ExportCapabilityInput): SensitiveExportCapability {
    this.assertSession();
    if (!input || typeof input !== "object" || input.confirmation !== "local-user-confirmed") {
      fail("export-capability-invalid", "a local user confirmation is required");
    }
    const purpose = validateExportPurpose(input.kind, input.purpose);
    const ttlMs = boundedTtl(input.ttlMs, DEFAULT_EXPORT_CAPABILITY_TTL_MS, MAX_EXPORT_CAPABILITY_TTL_MS);
    const now = this.currentTime();
    const capability = mintExportCapability({
      vaultId: this.vaultId,
      sessionId: this.session!.id,
      kind: input.kind,
      purpose,
      expiresAt: now + ttlMs,
    });
    return capability;
  }

  async exportMnemonic(input: {
    password: string;
    capability: SensitiveExportCapability;
  }): Promise<MnemonicExport> {
    assertPasswordInput(input.password);
    return this.serial(async () => {
      const record = this.consumeExportCapability(input.capability, "mnemonic");
      const parsed = await this.readKeystoreOrThrow();
      let wallet: HDNodeWallet;
      try {
        wallet = await decryptWallet(parsed, input.password);
      } catch (error) {
        this.lockInternal();
        throw error;
      }
      if (!wallet.mnemonic || wallet.mnemonic.password !== "") {
        fail("keystore-invalid", "the keystore has no recoverable BIP39 mnemonic");
      }
      this.assertSessionMatches(record.sessionId, wallet.address);
      return Object.freeze({
        kind: "mnemonic" as const,
        purpose: record.purpose,
        address: wallet.address,
        path: BIP44_EVM_PATH,
        mnemonic: wallet.mnemonic.phrase,
        warning: "Anyone with this mnemonic can control every account derived from it. Never share it.",
      });
    });
  }

  async exportPrivateKey(input: {
    password: string;
    capability: SensitiveExportCapability;
  }): Promise<PrivateKeyExport> {
    assertPasswordInput(input.password);
    return this.serial(async () => {
      const record = this.consumeExportCapability(input.capability, "private-key");
      const parsed = await this.readKeystoreOrThrow();
      let wallet: HDNodeWallet;
      try {
        wallet = await decryptWallet(parsed, input.password);
      } catch (error) {
        this.lockInternal();
        throw error;
      }
      this.assertSessionMatches(record.sessionId, wallet.address);
      return Object.freeze({
        kind: "private-key" as const,
        purpose: record.purpose,
        address: wallet.address,
        path: BIP44_EVM_PATH,
        privateKey: wallet.privateKey,
        warning: "This key controls the address above. Never paste it into a website or share it.",
      });
    });
  }

  previewTypedData(typedData: WalletTypedData): TypedDataPreview {
    const normalized = normalizeGenericTypedData(typedData);
    const digest = typedDataDigest(normalized);
    return Object.freeze({
      digest,
      chainId: normalized.chainId,
      primaryType: normalized.typedData.primaryType,
      typedData: normalized.typedData,
      signable: false as const,
      reason: "preview-only" as const,
    });
  }

  prepareTypedData(input: PrepareTypedDataInput): PreparedTypedData {
    const purpose = this.options.purposes.get(input.purpose);
    if (!purpose) fail("signing-purpose-invalid", `unknown signing purpose: ${safePurpose(input.purpose)}`);
    const documentChain = normalizeGenericTypedData(input.typedData).chainId;
    if (documentChain === null) fail("typed-data-invalid", "domain chain id is missing");
    assertSignableChain(documentChain, this.options.chainPolicy, this.options.allowedSigningChains);
    assertSignableChain(purpose.chainId, this.options.chainPolicy, this.options.allowedSigningChains);
    const normalized = normalizePurposeTypedData(purpose, input.typedData);
    const digest = typedDataDigest(normalized);
    const prepared: PreparedTypedData = Object.freeze({
      purpose: purpose.id,
      chainId: purpose.chainId,
      primaryType: purpose.primaryType,
      verifyingContract: normalized.verifyingContract,
      digest,
      signable: true as const,
    });
    preparedTypedDataRecords.set(prepared, { vaultId: this.vaultId, typedData: normalized.typedData, digest, purpose });
    return prepared;
  }

  createSigningPermit(input: SigningPermitInput): SigningPermit {
    this.assertSession();
    if (!input || typeof input !== "object") fail("signing-permit-invalid", "signing permit input is required");
    const ttlMs = boundedTtl(input.ttlMs, DEFAULT_SIGNING_PERMIT_TTL_MS, MAX_SIGNING_PERMIT_TTL_MS);
    const maxUses = input.maxUses ?? 1;
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_SIGNING_PERMIT_USES) {
      fail("signing-permit-invalid", `maxUses must be 1..${MAX_SIGNING_PERMIT_USES}`);
    }

    if (input.kind === "typed-data") {
      const record = preparedTypedDataRecords.get(input.prepared);
      if (!record || record.vaultId !== this.vaultId) {
        fail("signing-permit-invalid", "typed-data permit needs a prepared document from this vault");
      }
      const purpose = this.options.purposes.get(record.purpose.id);
      if (!purpose) fail("signing-purpose-invalid", "the signing purpose is no longer configured");
      assertSignableChain(purpose.chainId, this.options.chainPolicy, this.options.allowedSigningChains);
      return mintSigningPermit({
        vaultId: this.vaultId,
        sessionId: this.session!.id,
        kind: "typed-data",
        purpose: purpose.id,
        chainId: purpose.chainId,
        bindingHash: record.digest,
        expiresAt: this.currentTime() + ttlMs,
        maxUses,
        used: 0,
        maxPerPaymentWei: null,
        maxTotalWei: null,
        spentWei: 0n,
      });
    }

    if (input.kind !== "payment") fail("signing-permit-invalid", "unknown signing permit kind");
    if (input.purpose !== "payment" && input.purpose !== "auto-recharge") {
      fail("signing-permit-invalid", "payment permits use the payment or auto-recharge label");
    }
    const record = preparedPaymentRecords.get(input.prepared);
    if (!record || record.vaultId !== this.vaultId) {
      fail("signing-permit-invalid", "payment permit needs a prepared payment from this vault");
    }
    assertSignableChain(record.transaction.chainId, this.options.chainPolicy, this.options.allowedSigningChains);
    const worst = paymentWorstCaseWei(record.prepared);
    const maxPer = input.maxPerPaymentWei ?? worst;
    const maxTotal = input.maxTotalWei ?? worst * BigInt(maxUses);
    if (typeof maxPer !== "bigint" || typeof maxTotal !== "bigint" || maxPer <= 0n || maxTotal <= 0n) {
      fail("signing-permit-invalid", "payment permit needs positive per-payment and total limits");
    }
    if (maxPer < worst) fail("signing-permit-limit", "per-payment limit is below the worst-case payment cost");
    if (maxTotal < worst) fail("signing-permit-limit", "total limit is below the worst-case payment cost");
    if (maxPer > maxTotal) fail("signing-permit-invalid", "per-payment limit exceeds total limit");
    return mintSigningPermit({
      vaultId: this.vaultId,
      sessionId: this.session!.id,
      kind: "payment",
      purpose: input.purpose,
      chainId: record.transaction.chainId,
      bindingHash: paymentIntentHash(record.prepared),
      expiresAt: this.currentTime() + ttlMs,
      maxUses,
      used: 0,
      maxPerPaymentWei: maxPer,
      maxTotalWei: maxTotal,
      spentWei: 0n,
    });
  }

  signTypedData(input: {
    prepared: PreparedTypedData;
    permit: SigningPermit;
  }): SignedTypedData {
    const session = this.requireSession();
    const record = preparedTypedDataRecords.get(input.prepared);
    if (!record || record.vaultId !== this.vaultId) {
      fail("prepared-invalid", "typed data was not prepared by this vault");
    }
    if (
      input.prepared.purpose !== record.purpose.id ||
      input.prepared.chainId !== record.purpose.chainId ||
      input.prepared.digest !== record.digest
    ) {
      fail("prepared-invalid", "prepared typed data does not match this vault's record");
    }
    const purpose = this.options.purposes.get(record.purpose.id);
    if (!purpose) fail("signing-purpose-invalid", "the signing purpose is no longer configured");
    assertSignableChain(purpose.chainId, this.options.chainPolicy, this.options.allowedSigningChains);
    if (record.digest !== typedDataDigest(normalizePurposeTypedData(purpose, record.typedData))) {
      fail("prepared-invalid", "prepared typed data no longer matches its purpose");
    }
    this.consumeSigningPermit(input.permit, "typed-data", purpose.id, purpose.chainId, null, record.digest);
    const signature = session.wallet.signingKey.sign(record.digest).serialized;
    return Object.freeze({
      signature,
      digest: record.digest,
      address: session.wallet.address,
      chainId: purpose.chainId,
      purpose: purpose.id,
      primaryType: purpose.primaryType,
      verifyingContract: input.prepared.verifyingContract,
    });
  }

  preparePayment(input: PaymentRequestInput): PreparedPayment {
    if (this.publicAddress === null) fail("wallet-absent", "no wallet exists");
    assertSignableChain(input.chainId, this.options.chainPolicy, this.options.allowedSigningChains);
    if (!Number.isSafeInteger(input.chainId) || input.chainId < 1) {
      fail("payment-invalid", "chain id must be a positive safe integer");
    }
    if (typeof input.valueWei !== "bigint" || input.valueWei <= 0n || input.valueWei > UINT256_MAX) {
      fail("payment-invalid", "payment value must be a positive uint256 bigint");
    }
    if (!Number.isSafeInteger(input.nonce) || input.nonce < 0) {
      fail("payment-invalid", "nonce must be a non-negative safe integer");
    }
    if (
      typeof input.gasLimit !== "bigint" ||
      typeof input.maxFeePerGas !== "bigint" ||
      typeof input.maxPriorityFeePerGas !== "bigint" ||
      input.gasLimit <= 0n ||
      input.gasLimit > UINT256_MAX ||
      input.maxFeePerGas <= 0n ||
      input.maxFeePerGas > UINT256_MAX ||
      input.maxPriorityFeePerGas < 0n ||
      input.maxPriorityFeePerGas > UINT256_MAX ||
      input.maxPriorityFeePerGas > input.maxFeePerGas
    ) {
      fail("payment-invalid", "invalid gas or fee fields");
    }
    return this.preparePaymentCore(input, "native", null);
  }

  private preparePaymentCore(
    input: PaymentRequestInput,
    kind: "native" | "erc20",
    token: { tokenAddress: string; tokenAmountRaw: string; tokenDecimals: number } | null,
  ): PreparedPayment {
    if (this.publicAddress === null) fail("wallet-absent", "no wallet exists");
    assertSignableChain(input.chainId, this.options.chainPolicy, this.options.allowedSigningChains);
    if (!Number.isSafeInteger(input.chainId) || input.chainId < 1) fail("payment-invalid", "chain id must be a positive safe integer");
    if (typeof input.valueWei !== "bigint" || input.valueWei < 0n || input.valueWei > UINT256_MAX) {
      fail("payment-invalid", "payment value must be a uint256 bigint");
    }
    if (kind === "native" && input.valueWei <= 0n) fail("payment-invalid", "a native payment needs a positive value");
    if (kind === "erc20" && input.valueWei !== 0n) fail("payment-invalid", "a token payment must not send native value");
    if (!Number.isSafeInteger(input.nonce) || input.nonce < 0) fail("payment-invalid", "nonce must be a non-negative safe integer");
    if (
      typeof input.gasLimit !== "bigint" ||
      typeof input.maxFeePerGas !== "bigint" ||
      typeof input.maxPriorityFeePerGas !== "bigint" ||
      input.gasLimit <= 0n ||
      input.gasLimit > UINT256_MAX ||
      input.maxFeePerGas <= 0n ||
      input.maxFeePerGas > UINT256_MAX ||
      input.maxPriorityFeePerGas < 0n ||
      input.maxPriorityFeePerGas > UINT256_MAX ||
      input.maxPriorityFeePerGas > input.maxFeePerGas
    ) {
      fail("payment-invalid", "invalid gas or fee fields");
    }
    let to: string;
    try {
      to = getAddress(input.to);
    } catch {
      fail("payment-invalid", "payment recipient is not a valid address");
    }
    if (to === "0x0000000000000000000000000000000000000000") {
      fail("payment-invalid", "payment recipient must not be the zero address");
    }
    const data = input.data ?? "0x";
    if (typeof data !== "string" || data.length > MAX_PAYMENT_DATA_BYTES * 2 + 2) {
      fail("payment-invalid", "payment data is too large");
    }
    if (!isHexData(data)) fail("payment-invalid", "payment data must be an even-length hex string");
    if (kind === "erc20" && (!token || data === "0x")) fail("payment-invalid", "a token payment needs exact calldata and token metadata");
    const normalizedData = data.toLowerCase();
    const maxGasCostWei = input.gasLimit * input.maxFeePerGas;
    const maxCostWei = input.valueWei + maxGasCostWei;
    if (maxCostWei > UINT256_MAX) fail("payment-invalid", "worst-case payment exceeds uint256");
    const transaction = {
      type: 2 as const,
      chainId: input.chainId,
      to,
      value: input.valueWei,
      data: normalizedData,
      nonce: input.nonce,
      gasLimit: input.gasLimit,
      maxFeePerGas: input.maxFeePerGas,
      maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    };
    const prepared: PreparedPayment = Object.freeze({
      from: this.publicAddress,
      chainId: input.chainId,
      to,
      kind,
      tokenAddress: token ? token.tokenAddress.toLowerCase() : null,
      tokenAmountRaw: token ? token.tokenAmountRaw : null,
      tokenDecimals: token ? token.tokenDecimals : null,
      valueWei: input.valueWei.toString(),
      nonce: input.nonce,
      gasLimit: input.gasLimit.toString(),
      maxFeePerGas: input.maxFeePerGas.toString(),
      maxPriorityFeePerGas: input.maxPriorityFeePerGas.toString(),
      maxGasCostWei: maxGasCostWei.toString(),
      maxCostWei: maxCostWei.toString(),
      data: normalizedData,
      signable: true as const,
    });
    preparedPaymentRecords.set(prepared, { vaultId: this.vaultId, transaction, prepared });
    return prepared;
  }

  /**
   * Prepares one exact ERC-20 `transfer(recipient, amount)` on an allowed
   * testnet. The token amount is not native value: the permit and the signed
   * transaction bind the exact calldata (selector, recipient, amount), and the
   * native budget is the gas ceiling only. The caller must separately verify
   * the calldata hash against its own trusted binding.
   */
  prepareErc20Payment(input: PaymentRequestInput & {
    tokenAddress: string;
    recipient: string;
    amountRaw: string;
    decimals: number;
  }): PreparedPayment {
    if (this.publicAddress === null) fail("wallet-absent", "no wallet exists");
    assertSignableChain(input.chainId, this.options.chainPolicy, this.options.allowedSigningChains);
    if (!Number.isSafeInteger(input.chainId) || input.chainId < 1) fail("payment-invalid", "chain id must be a positive safe integer");
    if (typeof input.amountRaw !== "string" || !/^(?:0|[1-9][0-9]{0,77})$/.test(input.amountRaw) || input.amountRaw === "0") {
      fail("payment-invalid", "token amount must be a positive uint256 decimal string");
    }
    const amount = BigInt(input.amountRaw);
    if (amount > UINT256_MAX) fail("payment-invalid", "token amount exceeds uint256");
    if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 36) fail("payment-invalid", "token decimals are invalid");
    let token: string;
    let recipient: string;
    try {
      token = getAddress(input.tokenAddress);
      recipient = getAddress(input.recipient);
    } catch {
      fail("payment-invalid", "token or recipient is not a valid address");
    }
    if (/^0x0{40}$/i.test(token) || /^0x0{40}$/i.test(recipient)) fail("payment-invalid", "token and recipient must not be the zero address");
    const data = `0xa9059cbb${recipient.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
    const prepared = this.preparePaymentCore({
      chainId: input.chainId,
      to: token,
      valueWei: 0n,
      data,
      nonce: input.nonce,
      gasLimit: input.gasLimit,
      maxFeePerGas: input.maxFeePerGas,
      maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    }, "erc20", { tokenAddress: token, tokenAmountRaw: input.amountRaw, tokenDecimals: input.decimals });
    return prepared;
  }

  async signPayment(input: { prepared: PreparedPayment; permit: SigningPermit }): Promise<SignedPayment> {
    const session = this.requireSession();
    const record = preparedPaymentRecords.get(input.prepared);
    if (!record || record.vaultId !== this.vaultId) {
      fail("prepared-invalid", "payment was not prepared by this vault");
    }
    if (record.prepared.from !== session.wallet.address) {
      fail("payment-invalid", "prepared payment belongs to a different account");
    }
    assertSignableChain(record.transaction.chainId, this.options.chainPolicy, this.options.allowedSigningChains);
    const permit = this.consumeSigningPermit(
      input.permit,
      "payment",
      null,
      record.transaction.chainId,
      paymentWorstCaseWei(record.prepared),
      paymentIntentHash(record.prepared),
    ) as PaymentPurpose;
    const rawTransaction = await session.wallet.signTransaction(record.transaction);
    this.expireSessionIfNeeded();
    if (this.session?.id !== session.id) {
      fail("wallet-session-expired", "the wallet session ended during signing");
    }
    let parsed: Transaction;
    try {
      parsed = Transaction.from(rawTransaction);
    } catch {
      fail("payment-invalid", "the signed transaction could not be parsed");
    }
    if (
      parsed.type !== 2 ||
      parsed.chainId !== BigInt(record.transaction.chainId) ||
      parsed.to?.toLowerCase() !== record.transaction.to.toLowerCase() ||
      parsed.value !== record.transaction.value ||
      parsed.nonce !== record.transaction.nonce ||
      parsed.data !== record.transaction.data ||
      parsed.gasLimit !== record.transaction.gasLimit ||
      parsed.maxFeePerGas !== record.transaction.maxFeePerGas ||
      parsed.maxPriorityFeePerGas !== record.transaction.maxPriorityFeePerGas ||
      parsed.from?.toLowerCase() !== session.wallet.address.toLowerCase()
    ) {
      fail("payment-invalid", "the signed transaction does not match the prepared payment");
    }
    return Object.freeze({
      rawTransaction,
      hash: keccak256(rawTransaction),
      from: session.wallet.address,
      to: record.transaction.to,
      chainId: record.transaction.chainId,
      valueWei: record.transaction.value.toString(),
      maxGasCostWei: record.prepared.maxGasCostWei,
      maxCostWei: record.prepared.maxCostWei,
      nonce: record.transaction.nonce,
      purpose: permit,
      broadcast: false as const,
    });
  }

  private assertSession(): Session {
    this.expireSessionIfNeeded();
    if (!this.session) fail("wallet-locked", "wallet is locked");
    return this.session;
  }

  private requireSession(): Session {
    return this.assertSession();
  }

  private assertSessionMatches(sessionId: string, address: string): void {
    const session = this.assertSession();
    if (session.id !== sessionId || session.address !== address) {
      this.lockInternal();
      fail("wallet-session-expired", "the wallet session changed during the sensitive operation");
    }
  }

  private consumeExportCapability(
    capability: SensitiveExportCapability,
    expectedKind: SensitiveExportKind,
  ): CapabilityRecord {
    this.assertSession();
    const record = exportCapabilityRecord(capability);
    if (!record || record.vaultId !== this.vaultId || record.sessionId !== this.session!.id) {
      fail("export-capability-invalid", "export capability is not valid for this session");
    }
    if (record.kind !== expectedKind) fail("export-purpose-mismatch", "export capability kind does not match");
    if (record.used) fail("export-capability-used", "export capability was already used");
    if (this.currentTime() >= record.expiresAt) fail("export-capability-expired", "export capability expired");
    record.used = true;
    return record;
  }

  private consumeSigningPermit(
    permit: SigningPermit,
    expectedKind: SigningPermitKind,
    expectedPurpose: string | null,
    chainId: number,
    spendWei: bigint | null,
    bindingHash: string,
  ): string {
    const session = this.assertSession();
    const record = signingPermitRecord(permit);
    if (!record || record.vaultId !== this.vaultId || record.sessionId !== session.id) {
      fail("signing-permit-invalid", "signing permit is not valid for this session");
    }
    if (record.kind !== expectedKind) fail("signing-permit-invalid", "signing permit kind does not match");
    if (expectedPurpose !== null && record.purpose !== expectedPurpose) {
      fail("signing-permit-invalid", "signing permit purpose does not match");
    }
    if (record.chainId !== chainId) fail("signing-permit-invalid", "signing permit chain does not match");
    if (record.bindingHash !== bindingHash) {
      fail("signing-permit-invalid", "signing permit is bound to a different intent");
    }
    if (this.currentTime() >= record.expiresAt) fail("signing-permit-expired", "signing permit expired");
    if (record.used >= record.maxUses) fail("signing-permit-exhausted", "signing permit has no uses left");
    if (spendWei === null) {
      if (record.maxPerPaymentWei !== null) fail("signing-permit-invalid", "typed-data permit has payment limits");
    } else {
      if (record.maxPerPaymentWei === null || record.maxTotalWei === null) {
        fail("signing-permit-invalid", "payment permit has no spend limits");
      }
      if (spendWei > record.maxPerPaymentWei) {
        fail("signing-permit-limit", "worst-case payment exceeds the per-payment limit");
      }
      if (record.spentWei + spendWei > record.maxTotalWei) {
        fail("signing-permit-limit", "worst-case payment exceeds the total permit limit");
      }
      record.spentWei += spendWei;
    }
    record.used += 1;
    return record.purpose;
  }

  private async assertCanReplace(replace: boolean, currentPassword?: string): Promise<void> {
    const exists = await pathExists(this.options.path);
    if (!exists) return;
    if (!replace) fail("wallet-exists", "a wallet already exists; pass replace to overwrite it");
    if (typeof currentPassword !== "string" || currentPassword.length === 0) {
      fail("password-invalid", "replacing an existing wallet requires its current password");
    }
    const parsed = await this.readKeystoreOrThrow();
    await decryptWallet(parsed, currentPassword);
  }

  private async reloadPublicAddress(): Promise<void> {
    const parsed = await this.readKeystore();
    this.publicAddress = parsed?.address ?? null;
    this.lockInternal();
  }

  private async readKeystoreOrThrow(): Promise<ParsedKeystore> {
    const parsed = await this.readKeystore();
    if (!parsed) fail("wallet-absent", "no wallet exists");
    return parsed;
  }

  private async readKeystore(): Promise<ParsedKeystore | null> {
    return readKeystoreFile(this.options.path);
  }

  private async persist(wallet: HDNodeWallet, password: string, replace: boolean): Promise<void> {
    let text: string;
    try {
      text = await encryptWallet(wallet, password, this.options.kdf);
    } catch (error) {
      if (error instanceof WalletVaultError) throw error;
      fail("wallet-io", "could not encrypt the wallet");
    }
    const parsed = validateKeystore(text);
    if (parsed.address.toLowerCase() !== wallet.address.toLowerCase()) {
      fail("keystore-invalid", "encrypted wallet address does not match the derived account");
    }
    if (byteLength(text) > MAX_KEYSTORE_BYTES) fail("keystore-invalid", "generated keystore is too large");
    await writeKeystoreAtomic(this.options.path, text, replace);
    this.publicAddress = wallet.address;
    this.lockInternal();
  }

  private currentTime(): number {
    const value = this.options.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("config-invalid", "wallet clock returned an invalid timestamp");
    }
    return value;
  }

  private expireSessionIfNeeded(): void {
    if (this.session && this.currentTime() >= this.session.expiresAt) this.lockInternal();
  }

  private lockInternal(): void {
    // Dropping the last reference is the only cleanup JavaScript can honestly
    // promise. A copied key may still be reachable by a heap dump or a crash.
    this.session = null;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous
      .catch(() => {
        /* a previous operation's failure must not poison the queue */
      })
      .then(operation)
      .finally(release);
  }
}

// --- options and validation -------------------------------------------------

function resolveOptions(options: WalletVaultOptions): ResolvedVaultOptions {
  if (!options || typeof options.path !== "string" || options.path.trim() === "") {
    fail("config-invalid", "wallet vault needs a file path");
  }
  const now = options.now ?? (() => Date.now());
  if (typeof now !== "function") fail("config-invalid", "now must be a function");
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  if (!Number.isInteger(sessionTtlMs) || sessionTtlMs < 1_000 || sessionTtlMs > MAX_SESSION_TTL_MS) {
    fail("config-invalid", `session TTL must be 1000..${MAX_SESSION_TTL_MS} ms`);
  }
  const kdf = validateKdf({ ...DEFAULT_KDF, ...(options.kdf ?? {}) });
  const chainPolicy = options.chainPolicy ?? DENY_ALL_CHAIN_POLICY;
  if (!chainPolicy || typeof chainPolicy.classify !== "function") {
    fail("config-invalid", "chain policy must implement classify(chainId)");
  }
  const allowedSigningChains = buildAllowedSigningChains(options.isolatedSimulationChains);
  const purposes = new Map<string, WalletTypedDataPurpose>();
  for (const raw of options.purposes ?? []) {
    const purpose = normalizePurpose(raw);
    if (purposes.has(purpose.id)) fail("config-invalid", `duplicate signing purpose: ${purpose.id}`);
    purposes.set(purpose.id, purpose);
  }
  return {
    path: resolve(options.path),
    now,
    sessionTtlMs,
    kdf,
    chainPolicy,
    purposes,
    allowedSigningChains,
  };
}

function buildAllowedSigningChains(
  isolatedSimulationChains: readonly number[] | undefined,
): ReadonlyMap<number, "testnet" | "simulation"> {
  const allowed = new Map<number, "testnet" | "simulation">();
  for (const chainId of SIGNING_CHAIN_ALLOWLIST_INTERNAL) allowed.set(chainId, "testnet");
  for (const chainId of isolatedSimulationChains ?? []) {
    if (!Number.isSafeInteger(chainId) || !ISOLATED_SIMULATION_CHAIN_ALLOWLIST.includes(chainId)) {
      fail("config-invalid", "isolated simulation chains are limited to 31337");
    }
    allowed.set(chainId, "simulation");
  }
  return allowed;
}

function normalizePurpose(raw: WalletTypedDataPurpose): WalletTypedDataPurpose {
  if (!raw || typeof raw !== "object") fail("config-invalid", "signing purpose must be an object");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.id)) fail("config-invalid", "invalid signing purpose id");
  if (!Number.isSafeInteger(raw.chainId) || raw.chainId < 1) fail("config-invalid", "invalid purpose chain id");
  if (MAINNET_SIGNING_DENIED_CHAIN_IDS.includes(raw.chainId)) {
    fail("signing-mainnet-forbidden", "a signing purpose may not target mainnet 56/8453");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(raw.primaryType) || raw.primaryType === "EIP712Domain") {
    fail("config-invalid", "invalid primary type");
  }
  if (typeof raw.domainName !== "string" || raw.domainName.length === 0 || raw.domainName.length > 128) {
    fail("config-invalid", "invalid domain name");
  }
  if (typeof raw.domainVersion !== "string" || raw.domainVersion.length === 0 || raw.domainVersion.length > 128) {
    fail("config-invalid", "invalid domain version");
  }
  if (!Array.isArray(raw.verifyingContracts) || raw.verifyingContracts.length === 0 || raw.verifyingContracts.length > 8) {
    fail("config-invalid", "signing purpose needs 1..8 verifying contracts");
  }
  const verifyingContracts = raw.verifyingContracts.map((value) => {
    try {
      return getAddress(value);
    } catch {
      fail("config-invalid", "signing purpose has an invalid verifying contract");
    }
  });
  if (!raw.messageTypes || typeof raw.messageTypes !== "object") {
    fail("config-invalid", "signing purpose needs messageTypes");
  }
  const messageTypes: Record<string, string> = Object.create(null) as Record<string, string>;
  const entries = Object.entries(raw.messageTypes);
  if (entries.length === 0 || entries.length > 16) fail("config-invalid", "signing purpose needs 1..16 fields");
  for (const [name, type] of entries) {
    if (!isSafeKey(name) || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      fail("config-invalid", "invalid message field name");
    }
    if (name.toLowerCase() === "chainid" && name !== "chainId") {
      fail("config-invalid", "message chainId must use the exact canonical field name");
    }
    if (typeof type !== "string" || !isPrimitiveTypedDataType(type)) {
      fail("config-invalid", "signing purpose fields must be primitive EIP-712 types");
    }
    messageTypes[name] = type;
  }
  return Object.freeze({
    id: raw.id,
    chainId: raw.chainId,
    primaryType: raw.primaryType,
    domainName: raw.domainName,
    domainVersion: raw.domainVersion,
    verifyingContracts: Object.freeze(verifyingContracts),
    messageTypes: Object.freeze(messageTypes),
  });
}

function isPrimitiveTypedDataType(type: string): boolean {
  if (["address", "bool", "string", "bytes"].includes(type)) return true;
  const bytesN = /^bytes([1-9]|[12][0-9]|3[0-2])$/.exec(type);
  if (bytesN) return true;
  const intN = /^u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)$/.exec(type);
  return intN !== null;
}

function validateKdf(params: WalletKdfParams): WalletKdfParams {
  const { N, r, p } = params;
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
    fail("config-invalid", "scrypt parameters must be integers");
  }
  if (N < MIN_KDF_N || N > MAX_KDF_N || (N & (N - 1)) !== 0) {
    fail("config-invalid", `scrypt N must be a power of two in [${MIN_KDF_N}, ${MAX_KDF_N}]`);
  }
  if (r < 1 || r > 16) fail("config-invalid", "scrypt r must be 1..16");
  if (p < 1 || p > 4) fail("config-invalid", "scrypt p must be 1..4");
  if (128 * N * r > MAX_KDF_MEMORY_BYTES) fail("config-invalid", "scrypt memory exceeds the safety bound");
  if (N * p > 1_048_576) fail("config-invalid", "scrypt work exceeds the safety bound");
  return Object.freeze({ N, r, p });
}

function normalizeMnemonic(input: string): string {
  if (typeof input !== "string" || input.length > 4096) fail("mnemonic-invalid", "invalid mnemonic");
  const words = input.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    fail("mnemonic-invalid", "mnemonic must have 12/15/18/21/24 words");
  }
  return words.join(" ");
}

function parseMnemonic(phrase: string): Mnemonic {
  try {
    const mnemonic = Mnemonic.fromPhrase(phrase);
    if (mnemonic.password !== "" || mnemonic.wordlist.locale !== "en") {
      fail("mnemonic-invalid", "only an English BIP39 mnemonic without a passphrase is supported");
    }
    return mnemonic;
  } catch (error) {
    if (error instanceof WalletVaultError) throw error;
    fail("mnemonic-invalid", "invalid BIP39 mnemonic or checksum");
  }
}

function assertNewPassword(password: string): void {
  if (typeof password !== "string" || password.length < 12) {
    fail("password-policy", "wallet password must have at least 12 characters");
  }
  if (password.length > 1024 || byteLength(password) > 1024) {
    fail("password-policy", "wallet password must be at most 1024 UTF-8 bytes");
  }
  if (password.trim().length === 0) fail("password-policy", "wallet password must not be blank");
}

function assertPasswordInput(password: string): void {
  if (typeof password !== "string" || password.length === 0) {
    fail("password-invalid", "wallet password is required");
  }
  if (password.length > 1024 || byteLength(password) > 1024) {
    fail("password-invalid", "wallet password is too long");
  }
}

function boundedTtl(value: number | undefined, fallback: number, maximum: number): number {
  const ttl = value ?? fallback;
  if (!Number.isInteger(ttl) || ttl < 1_000 || ttl > maximum) {
    fail("config-invalid", `TTL must be 1000..${maximum} ms`);
  }
  return ttl;
}

function validateExportPurpose(kind: SensitiveExportKind, purpose: SensitiveExportPurpose): SensitiveExportPurpose {
  const allowed: Record<SensitiveExportKind, readonly SensitiveExportPurpose[]> = {
    mnemonic: ["wallet-recovery", "wallet-migration"],
    "private-key": ["eip155-external-wallet", "wallet-migration"],
  };
  const purposes = allowed[kind];
  if (!purposes || !purposes.includes(purpose)) {
    fail("export-purpose-mismatch", "export purpose is not valid for this kind");
  }
  return purpose;
}

function safePurpose(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9._-]{1,64}$/.test(value) ? value : "invalid";
}

// --- keystore parsing, KDF bounds, and atomic files --------------------------

async function encryptWallet(wallet: HDNodeWallet, password: string, kdf: WalletKdfParams): Promise<string> {
  if (
    !wallet.mnemonic ||
    wallet.mnemonic.password !== "" ||
    wallet.mnemonic.wordlist.locale !== "en" ||
    wallet.path !== BIP44_EVM_PATH
  ) {
    fail("keystore-invalid", "refusing to encrypt a wallet without the expected BIP39 mnemonic/path");
  }
  return encryptKeystoreJson(
    {
      address: wallet.address,
      privateKey: wallet.privateKey,
      mnemonic: {
        path: BIP44_EVM_PATH,
        locale: "en",
        entropy: wallet.mnemonic.entropy,
      },
    },
    password,
    { scrypt: { N: kdf.N, r: kdf.r, p: kdf.p } },
  );
}

async function decryptWallet(parsed: ParsedKeystore, password: string): Promise<HDNodeWallet> {
  let wallet: Wallet | HDNodeWallet;
  try {
    wallet = await Wallet.fromEncryptedJson(parsed.text, password);
  } catch {
    fail("password-invalid", "wallet password verification failed");
  }
  if (!(wallet instanceof HDNodeWallet) || !wallet.mnemonic) {
    fail("keystore-invalid", "the keystore does not contain a recoverable BIP39 mnemonic");
  }
  if (wallet.mnemonic.password !== "" || wallet.mnemonic.wordlist.locale !== "en") {
    fail("keystore-invalid", "the keystore mnemonic has an unsupported passphrase or wordlist");
  }
  if (wallet.path !== BIP44_EVM_PATH) fail("keystore-invalid", "the keystore uses an unexpected BIP44 path");
  if (wallet.address.toLowerCase() !== parsed.address.toLowerCase()) {
    fail("keystore-invalid", "the decrypted key does not match the declared address");
  }
  // The V3 MAC authenticates the private-key ciphertext and password; the
  // x-ethers mnemonic ciphertext is not separately MAC'd. Re-parse the phrase,
  // re-derive the fixed path, and compare address/private key before exposing
  // the wallet. A wordlist-valid phrase alone is not treated as integrity.
  let reparsed: Mnemonic;
  try {
    reparsed = Mnemonic.fromPhrase(wallet.mnemonic.phrase);
  } catch {
    fail("keystore-invalid", "the decrypted mnemonic failed BIP39 checksum validation");
  }
  if (reparsed.entropy.toLowerCase() !== wallet.mnemonic.entropy.toLowerCase()) {
    fail("keystore-invalid", "the mnemonic phrase and encrypted entropy disagree");
  }
  const derived = HDNodeWallet.fromMnemonic(reparsed, BIP44_EVM_PATH);
  if (
    derived.address.toLowerCase() !== wallet.address.toLowerCase() ||
    derived.privateKey.toLowerCase() !== wallet.privateKey.toLowerCase() ||
    derived.address.toLowerCase() !== parsed.address.toLowerCase()
  ) {
    fail("keystore-invalid", "the mnemonic, path, address and private key are inconsistent");
  }
  return wallet;
}

function validateKeystore(text: string): ParsedKeystore {
  if (typeof text !== "string" || text.length > MAX_KEYSTORE_BYTES || byteLength(text) > MAX_KEYSTORE_BYTES) {
    fail("keystore-invalid", "keystore is missing or too large");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("keystore-invalid", "keystore is not valid JSON");
  }
  if (!isRecord(raw)) fail("keystore-invalid", "keystore must be a JSON object");
  rejectUnknownKeys(raw, ["version", "id", "address", "crypto", "x-ethers"], "keystore");
  if (raw.version !== 3) fail("keystore-invalid", "only Web3 keystore version 3 is supported");
  if (typeof raw.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.id)) {
    fail("keystore-invalid", "keystore id is not a UUID");
  }
  const address = parseAddress(raw.address);

  const crypto = uniqueField(raw, "crypto", "keystore");
  if (!isRecord(crypto)) fail("keystore-invalid", "keystore crypto section is missing");
  rejectUnknownKeys(crypto, ["cipher", "cipherparams", "ciphertext", "kdf", "kdfparams", "mac"], "crypto");
  if (crypto.cipher !== "aes-128-ctr") fail("keystore-invalid", "only aes-128-ctr is supported");
  const cipherparams = uniqueField(crypto, "cipherparams", "crypto");
  if (!isRecord(cipherparams)) fail("keystore-invalid", "cipherparams is missing");
  rejectUnknownKeys(cipherparams, ["iv"], "cipherparams");
  if (hexByteLength(cipherparams.iv) !== 16) fail("keystore-invalid", "keystore IV must be 16 bytes");
  if (hexByteLength(crypto.ciphertext) !== 32) fail("keystore-invalid", "keystore ciphertext must be 32 bytes");
  if (hexByteLength(crypto.mac) !== 32) fail("keystore-invalid", "keystore MAC must be 32 bytes");
  if (crypto.kdf !== "scrypt") fail("keystore-weak-kdf", "only the scrypt KDF is accepted");

  const kdfparams = uniqueField(crypto, "kdfparams", "crypto");
  if (!isRecord(kdfparams)) fail("keystore-invalid", "kdfparams is missing");
  rejectUnknownKeys(kdfparams, ["dklen", "n", "r", "p", "salt"], "kdfparams");
  if (kdfparams.dklen !== 32) fail("keystore-invalid", "keystore dklen must be 32");
  if (typeof kdfparams.n !== "number" || typeof kdfparams.r !== "number" || typeof kdfparams.p !== "number") {
    fail("keystore-invalid", "scrypt parameters must be numbers");
  }
  let kdf: WalletKdfParams;
  try {
    kdf = validateKdf({ N: kdfparams.n, r: kdfparams.r, p: kdfparams.p });
  } catch (error) {
    if (!(error instanceof WalletVaultError)) throw error;
    const code: WalletVaultErrorCode =
      kdfparams.n > MAX_KDF_N || kdfparams.r > 16 || kdfparams.p > 4 ? "keystore-dos" : "keystore-weak-kdf";
    fail(code, error.message);
  }
  const saltBytes = hexByteLength(kdfparams.salt);
  if (saltBytes === null || saltBytes < 16 || saltBytes > 64) fail("keystore-invalid", "keystore salt must be 16..64 bytes");

  const xethers = uniqueField(raw, "x-ethers", "keystore");
  if (!isRecord(xethers)) fail("keystore-invalid", "keystore has no encrypted BIP39 mnemonic");
  rejectUnknownKeys(xethers, ["version", "path", "locale", "mnemonicCounter", "mnemonicCiphertext", "client", "gethFilename"], "x-ethers");
  if (xethers.version !== "0.1") fail("keystore-invalid", "unsupported x-ethers metadata version");
  if (xethers.path !== BIP44_EVM_PATH) fail("keystore-invalid", "keystore uses an unexpected BIP44 path");
  if (xethers.locale !== "en") fail("keystore-invalid", "only the English BIP39 wordlist is supported");
  if (typeof xethers.client !== "string" || xethers.client.length > 128) {
    fail("keystore-invalid", "keystore client metadata is missing or malformed");
  }
  const clientMatch = ETHERS_CLIENT_RE.exec(xethers.client);
  if (!clientMatch || Number(clientMatch[1]) !== 6) {
    fail("keystore-invalid", "keystore client metadata is not a supported ethers/6.x format");
  }
  if (
    typeof xethers.gethFilename !== "string" ||
    !GETH_FILENAME_RE.test(xethers.gethFilename) ||
    !xethers.gethFilename.toLowerCase().endsWith(address.slice(2).toLowerCase())
  ) {
    fail("keystore-invalid", "keystore geth filename is missing or does not belong to the declared address");
  }
  if (hexByteLength(xethers.mnemonicCounter) !== 16) fail("keystore-invalid", "mnemonic counter must be 16 bytes");
  const entropyBytes = hexByteLength(xethers.mnemonicCiphertext);
  if (entropyBytes === null || ![16, 20, 24, 28, 32].includes(entropyBytes)) {
    fail("keystore-invalid", "mnemonic ciphertext must be 16/20/24/28/32 bytes");
  }

  return Object.freeze({ text, address, kdf, mnemonicEntropyBytes: entropyBytes });
}

async function readKeystoreFile(path: string): Promise<ParsedKeystore | null> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    fail("wallet-io", "could not inspect the wallet file");
  }
  if (stat.isSymbolicLink()) fail("wallet-file-permissions", "the wallet file must not be a symlink");
  if (!stat.isFile()) fail("wallet-file-permissions", "the wallet path is not a regular file");
  if (stat.size > MAX_KEYSTORE_BYTES) fail("wallet-file-too-large", "the wallet file is too large");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    fail("wallet-file-permissions", "the wallet file must be mode 0600 (owner-only)");
  }
  const noFollow = ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0) as number;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile()) fail("wallet-file-permissions", "the wallet path is not a regular file");
    if (opened.size > MAX_KEYSTORE_BYTES) fail("wallet-file-too-large", "the wallet file is too large");
    if (process.platform !== "win32" && (opened.mode & 0o077) !== 0) {
      fail("wallet-file-permissions", "the wallet file must be mode 0600 (owner-only)");
    }
    const text = await handle.readFile({ encoding: "utf8" });
    return validateKeystore(text);
  } catch (error) {
    if (error instanceof WalletVaultError) throw error;
    if (isNotFound(error)) return null;
    fail("wallet-io", "could not read the wallet file");
  } finally {
    await handle?.close().catch(() => {
      /* closing a read handle is best effort */
    });
  }
  fail("wallet-io", "could not read the wallet file");
}

async function writeKeystoreAtomic(path: string, text: string, replace: boolean): Promise<void> {
  if (text.length > MAX_KEYSTORE_BYTES || byteLength(text) > MAX_KEYSTORE_BYTES) {
    fail("wallet-io", "keystore is too large to write");
  }
  const dir = dirname(path);
  const existed = await pathExists(dir);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const dirStat = await lstat(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      fail("wallet-file-permissions", "the wallet directory must be a real directory");
    }
    if (!existed && process.platform !== "win32") await chmod(dir, 0o700);
  } catch (error) {
    if (error instanceof WalletVaultError) throw error;
    fail("wallet-io", "could not prepare the wallet directory");
  }

  if (replace) {
    try {
      const target = await lstat(path);
      if (target.isSymbolicLink()) fail("wallet-file-permissions", "the wallet file must not be a symlink");
      if (!target.isFile()) fail("wallet-file-permissions", "the wallet path is not a regular file");
    } catch (error) {
      if (error instanceof WalletVaultError) throw error;
      if (!isNotFound(error)) fail("wallet-io", "could not inspect the wallet file");
    }
  }

  const temp = `${path}.${nodeRandomBytes(12).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (replace) {
      await rename(temp, path);
    } else {
      try {
        await link(temp, path);
      } catch (error) {
        if (isAlreadyExists(error)) fail("wallet-exists", "a wallet already exists; pass replace to overwrite it");
        throw error;
      }
      await unlink(temp).catch(() => {
        /* the temporary name is only a hard link to the real file */
      });
    }
    await fsyncDirectory(dir);
  } catch (error) {
    await handle?.close().catch(() => {
      /* best effort */
    });
    await unlink(temp).catch(() => {
      /* best effort */
    });
    if (error instanceof WalletVaultError) throw error;
    fail("wallet-io", "could not write the wallet file");
  }
}

async function fsyncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* Windows and some filesystems do not support directory fsync */
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    fail("wallet-io", "could not inspect a wallet path");
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EEXIST";
}

function parseAddress(value: unknown): string {
  if (typeof value !== "string") fail("keystore-invalid", "keystore address is missing");
  const withPrefix = value.startsWith("0x") ? value : `0x${value}`;
  try {
    return getAddress(withPrefix);
  } catch {
    fail("keystore-invalid", "keystore address is invalid");
  }
}

function uniqueField(object: Record<string, unknown>, name: string, label: string): unknown {
  const matches = Object.keys(object).filter((key) => key.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) fail("keystore-invalid", `${label} is missing ${name}`);
  if (matches.length > 1) fail("keystore-invalid", `${label} has duplicate ${name} fields`);
  return object[matches[0]!];
}

function rejectUnknownKeys(object: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const lower = new Set(allowed.map((key) => key.toLowerCase()));
  const seen = new Set<string>();
  for (const key of Object.keys(object)) {
    const normalized = key.toLowerCase();
    if (!lower.has(normalized)) fail("keystore-invalid", `${label} contains an unsupported field`);
    if (seen.has(normalized)) fail("keystore-invalid", `${label} contains duplicate fields`);
    seen.add(normalized);
  }
}

function hexByteLength(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const body = value.startsWith("0x") ? value.slice(2) : value;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) return null;
  return body.length / 2;
}

function isHexData(value: string): boolean {
  return typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
}

function byteLength(value: string): number {
  // Buffer.byteLength measures UTF-8 without allocating an encoded copy of a
  // potentially hostile, oversized input.
  return Buffer.byteLength(value, "utf8");
}

// --- typing/signing helpers -------------------------------------------------

function assertSignableChain(
  chainId: number,
  policy: WalletChainPolicy,
  allowed: ReadonlyMap<number, "testnet" | "simulation">,
): WalletChainClass {
  if (!Number.isSafeInteger(chainId) || chainId < 1) fail("signing-disabled", "invalid chain id");
  if (MAINNET_SIGNING_DENIED_CHAIN_IDS.includes(chainId)) {
    fail("signing-mainnet-forbidden", `chain ${chainId} is hard-denied for signing`);
  }
  const expected = allowed.get(chainId);
  if (!expected) fail("signing-disabled", `chain ${chainId} is not in the signing allowlist`);
  let classification: WalletChainClass;
  try {
    classification = policy.classify(chainId);
  } catch {
    classification = "unknown";
  }
  if (classification !== expected) {
    fail("signing-disabled", `chain ${chainId} is not classified as the allowlisted ${expected} class`);
  }
  return classification;
}

function normalizeGenericTypedData(input: WalletTypedData): {
  typedData: WalletTypedData;
  chainId: number | null;
  verifyingContract: string | null;
} {
  if (!input || typeof input !== "object") fail("typed-data-invalid", "typed data must be an object");
  if (!isRecord(input.domain) || !isRecord(input.types) || !isRecord(input.message)) {
    fail("typed-data-invalid", "typed data needs domain, types and message objects");
  }
  if (typeof input.primaryType !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(input.primaryType)) {
    fail("typed-data-invalid", "invalid primary type");
  }
  if (input.primaryType === "EIP712Domain") fail("typed-data-invalid", "a domain-only document cannot be previewed as a message");
  if (!Array.isArray(input.types[input.primaryType])) fail("typed-data-invalid", "primary type is not declared");
  for (const [name, fields] of Object.entries(input.types)) {
    if (!isSafeKey(name) || !Array.isArray(fields)) fail("typed-data-invalid", "invalid EIP-712 type declaration");
    for (const field of fields) {
      if (!isRecord(field) || typeof field.name !== "string" || !isSafeKey(field.name) || typeof field.type !== "string") {
        fail("typed-data-invalid", "invalid EIP-712 field declaration");
      }
    }
  }
  const chainId = parseChainId(input.domain.chainId);
  let verifyingContract: string | null = null;
  if (input.domain.verifyingContract !== undefined) {
    try {
      verifyingContract = getAddress(String(input.domain.verifyingContract));
    } catch {
      fail("typed-data-invalid", "invalid verifying contract");
    }
  }
  const domain: Record<string, unknown> = { ...input.domain };
  if (chainId !== null) domain.chainId = chainId;
  if (verifyingContract !== null) domain.verifyingContract = verifyingContract;
  const hashTypes = Object.fromEntries(
    Object.entries(input.types).filter(([name]) => name !== "EIP712Domain"),
  ) as Record<string, readonly TypedDataField[]>;
  const typedData = freezeClone({
    domain: domain as TypedDataDomain,
    types: hashTypes,
    primaryType: input.primaryType,
    message: input.message,
  }) as WalletTypedData;
  return { typedData, chainId, verifyingContract };
}

function normalizePurposeTypedData(
  purpose: WalletTypedDataPurpose,
  input: WalletTypedData,
): {
  typedData: WalletTypedData;
  verifyingContract: string;
  chainId: number;
} {
  const generic = normalizeGenericTypedData(input);
  if (!isRecord(input.domain)) fail("typed-data-invalid", "typed data domain is missing");
  if (input.primaryType !== purpose.primaryType) fail("typed-data-invalid", "primary type does not match the signing purpose");
  const chainId = parseChainId(input.domain.chainId);
  if (chainId !== purpose.chainId) fail("typed-data-invalid", "domain chain id does not match the signing purpose");
  const domainKeys = Object.keys(input.domain).sort();
  const expectedDomainKeys = ["chainId", "name", "verifyingContract", "version"];
  if (domainKeys.length !== expectedDomainKeys.length || domainKeys.some((key, i) => key !== expectedDomainKeys[i])) {
    fail("typed-data-invalid", "domain contains fields the signing purpose does not allow");
  }
  const name = input.domain.name;
  const version = input.domain.version;
  if (name !== purpose.domainName || version !== purpose.domainVersion) {
    fail("typed-data-invalid", "domain name/version does not match the signing purpose");
  }
  if (generic.verifyingContract === null) fail("typed-data-invalid", "domain verifying contract is missing");
  const allowed = purpose.verifyingContracts.some(
    (value) => value.toLowerCase() === generic.verifyingContract!.toLowerCase(),
  );
  if (!allowed) fail("typed-data-invalid", "domain verifying contract does not match the signing purpose");

  const domainFields = input.types.EIP712Domain;
  if (!domainFields) fail("typed-data-invalid", "EIP712Domain type is missing");
  const expectedDomain: TypedDataField[] = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ];
  if (!sameFields(domainFields, expectedDomain)) {
    fail("typed-data-invalid", "EIP712Domain must be exactly name/version/chainId/verifyingContract");
  }
  const allowedTypeKeys = new Set(["EIP712Domain", purpose.primaryType]);
  for (const key of Object.keys(input.types)) {
    if (!allowedTypeKeys.has(key)) fail("typed-data-invalid", "signing purpose does not allow extra EIP-712 types");
  }
  const purposeFields = Object.entries(purpose.messageTypes).map(([name, type]) => ({ name, type }));
  const suppliedFields = input.types[purpose.primaryType];
  if (!suppliedFields || !sameFields(suppliedFields, purposeFields)) {
    fail("typed-data-invalid", "message fields do not match the signing purpose");
  }
  const messageKeys = Object.keys(input.message).sort();
  const expectedKeys = purposeFields.map((field) => field.name).sort();
  if (messageKeys.length !== expectedKeys.length || messageKeys.some((key, i) => key !== expectedKeys[i])) {
    fail("typed-data-invalid", "message keys do not match the signing purpose");
  }
  for (const field of purposeFields) {
    validateMessageValue(field.type, input.message[field.name], field.name);
  }
  if (purpose.messageTypes.chainId !== undefined) {
    const messageChain = parseChainId(input.message.chainId);
    if (messageChain === null || messageChain !== purpose.chainId) {
      fail("typed-data-invalid", "message chainId does not match the domain/purpose chain");
    }
  }
  if (purpose.messageTypes.assetId !== undefined) {
    if (purpose.messageTypes.assetId !== "string" || typeof input.message.assetId !== "string") {
      fail("typed-data-invalid", "message assetId must be a standard eip155 string");
    }
    const assetMatch = /^eip155:(\d+):0x[0-9a-fA-F]{40}$/.exec(input.message.assetId);
    if (!assetMatch) {
      fail("typed-data-invalid", "message assetId must be a complete eip155:<chain>:0x<40hex> identifier");
    }
    if (Number(assetMatch[1]) !== purpose.chainId) {
      fail("typed-data-invalid", "message assetId chain does not match the domain/purpose chain");
    }
  }

  const typedData = freezeClone({
    domain: {
      name: purpose.domainName,
      version: purpose.domainVersion,
      chainId: purpose.chainId,
      verifyingContract: generic.verifyingContract,
    } as TypedDataDomain,
    types: {
      EIP712Domain: expectedDomain,
      [purpose.primaryType]: purposeFields,
    },
    primaryType: purpose.primaryType,
    message: input.message,
  }) as WalletTypedData;
  return { typedData, verifyingContract: generic.verifyingContract, chainId: purpose.chainId };
}

/** Worst-case native spend: transfer value plus the maximum gas cost. */
export function paymentWorstCaseWei(prepared: PreparedPayment): bigint {
  return BigInt(prepared.valueWei) + BigInt(prepared.gasLimit) * BigInt(prepared.maxFeePerGas);
}

function paymentIntentHash(prepared: PreparedPayment): string {
  return keccak256(
    new TextEncoder().encode(
      [
        "oma-payment-v1",
        String(prepared.chainId),
        prepared.from.toLowerCase(),
        prepared.to.toLowerCase(),
        prepared.valueWei,
        String(prepared.nonce),
        prepared.gasLimit,
        prepared.maxFeePerGas,
        prepared.maxPriorityFeePerGas,
        prepared.data.toLowerCase(),
      ].join("|"),
    ),
  );
}

function typedDataDigest(input: { typedData: WalletTypedData; chainId: number | null }): string {
  const types = { ...input.typedData.types } as Record<string, readonly TypedDataField[]>;
  delete types.EIP712Domain;
  try {
    return TypedDataEncoder.hash(
      input.typedData.domain,
      types as Record<string, TypedDataField[]>,
      input.typedData.message,
    );
  } catch {
    fail("typed-data-invalid", "EIP-712 document could not be hashed");
  }
}

function sameFields(a: readonly TypedDataField[], b: readonly TypedDataField[]): boolean {
  return a.length === b.length && a.every((field, i) => field.name === b[i]!.name && field.type === b[i]!.type);
}

function validateMessageValue(type: string, value: unknown, label: string): void {
  if (value === undefined) fail("typed-data-invalid", `message field ${label} is missing`);
  if (type === "address") {
    if (typeof value !== "string" || !isAddress(value)) fail("typed-data-invalid", `message field ${label} is not an address`);
    return;
  }
  if (type === "bool") {
    if (typeof value !== "boolean") fail("typed-data-invalid", `message field ${label} is not a boolean`);
    return;
  }
  if (type === "string") {
    if (typeof value !== "string" || value.length > 4096) fail("typed-data-invalid", `message field ${label} is not a bounded string`);
    return;
  }
  if (type === "bytes" || /^bytes\d+$/.test(type)) {
    if (typeof value !== "string" || !isHexData(value)) fail("typed-data-invalid", `message field ${label} is not hex data`);
    if (type !== "bytes") {
      const expected = Number(type.slice(5));
      if (hexByteLength(value) !== expected) fail("typed-data-invalid", `message field ${label} has the wrong byte length`);
    }
    return;
  }
  if (/^u?int\d+$/.test(type)) {
    let integer: bigint;
    try {
      if (typeof value === "bigint") integer = value;
      else if (typeof value === "number" && Number.isSafeInteger(value)) integer = BigInt(value);
      else if (typeof value === "string" && /^-?[0-9]+$/.test(value)) integer = BigInt(value);
      else throw new Error("not an integer");
    } catch {
      fail("typed-data-invalid", `message field ${label} is not an integer`);
    }
    if (type.startsWith("uint") && integer < 0n) fail("typed-data-invalid", `message field ${label} is negative`);
    const bits = Number(type.replace(/^u?int/, ""));
    if (bits < 256 && (integer >= 2n ** BigInt(bits) || integer < -(2n ** BigInt(bits - 1)))) {
      fail("typed-data-invalid", `message field ${label} does not fit ${type}`);
    }
    return;
  }
  fail("typed-data-invalid", `message field ${label} has an unsupported type`);
}

function parseChainId(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  let id: bigint;
  try {
    if (typeof value === "bigint") id = value;
    else if (typeof value === "number" && Number.isSafeInteger(value)) id = BigInt(value);
    else if (typeof value === "string" && /^[0-9]+$/.test(value)) id = BigInt(value);
    else throw new Error("not a chain id");
  } catch {
    fail("typed-data-invalid", "domain chain id is invalid");
  }
  if (id < 1n || id > BigInt(Number.MAX_SAFE_INTEGER)) fail("typed-data-invalid", "domain chain id is out of range");
  return Number(id);
}

function freezeClone<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeClone(item))) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      Object.defineProperty(out, key, {
        value: freezeClone(item),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(out) as T;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeKey(value: string): boolean {
  return value !== "__proto__" && value !== "prototype" && value !== "constructor";
}

// --- auto-recharge policy (validated shape only; no executor) ----------------

/**
 * Validate a future auto-recharge policy. This module deliberately does not
 * execute top-ups or hold a timer: a later executor must turn this into a
 * bounded `SigningPermit` after a local opt-in and must re-check balance and
 * payment state. Mainnet 56/8453 is rejected here as well.
 */
export function validateAutoRechargePolicy(
  input: AutoRechargePolicy,
  options: {
    now: number;
    chainPolicy: WalletChainPolicy;
    maxTtlMs?: number;
    /** Test-only; only 31337 is accepted. */
    isolatedSimulationChains?: readonly number[];
  },
): AutoRechargePolicy {
  if (!input || typeof input !== "object") fail("auto-recharge-invalid", "auto-recharge policy must be an object");
  if (!Number.isSafeInteger(options.now) || options.now < 0) {
    fail("auto-recharge-invalid", "auto-recharge validation needs a valid clock");
  }
  if (input.version !== 1) fail("auto-recharge-invalid", "unsupported auto-recharge policy version");
  assertSignableChain(
    input.chainId,
    options.chainPolicy,
    buildAllowedSigningChains(options.isolatedSimulationChains),
  );
  if (!/^eip155:[0-9]+:0x[0-9a-fA-F]{40}$/.test(input.assetId)) {
    fail("auto-recharge-invalid", "asset id must be the explicit eip155 chain/token tuple");
  }
  const assetChain = Number(input.assetId.split(":")[1]);
  if (assetChain !== input.chainId) fail("auto-recharge-invalid", "asset id chain does not match the policy chain");
  if (typeof input.maxPerPaymentWei !== "bigint" || typeof input.maxTotalWei !== "bigint") {
    fail("auto-recharge-invalid", "limits must be bigint wei values");
  }
  if (input.maxPerPaymentWei <= 0n || input.maxTotalWei <= 0n || input.maxPerPaymentWei > input.maxTotalWei) {
    fail("auto-recharge-invalid", "invalid auto-recharge limits");
  }
  if (!Number.isInteger(input.maxPayments) || input.maxPayments < 1 || input.maxPayments > MAX_SIGNING_PERMIT_USES) {
    fail("auto-recharge-invalid", `maxPayments must be 1..${MAX_SIGNING_PERMIT_USES}`);
  }
  const maxTtl = options.maxTtlMs ?? MAX_AUTO_RECHARGE_TTL_MS;
  if (!Number.isInteger(input.expiresAt) || input.expiresAt <= options.now || input.expiresAt - options.now > maxTtl) {
    fail("auto-recharge-invalid", "auto-recharge permission must be a short, non-expired session");
  }
  if (typeof input.nonce !== "string" || !/^[A-Za-z0-9._-]{16,128}$/.test(input.nonce)) {
    fail("auto-recharge-invalid", "auto-recharge nonce must be 16..128 URL-safe characters");
  }
  if ((input.belowBalanceWei === undefined) !== (input.targetBalanceWei === undefined)) {
    fail("auto-recharge-invalid", "balance threshold and target must be provided together");
  }
  if (input.belowBalanceWei !== undefined && input.targetBalanceWei !== undefined) {
    if (
      typeof input.belowBalanceWei !== "bigint" ||
      typeof input.targetBalanceWei !== "bigint" ||
      input.belowBalanceWei < 0n ||
      input.targetBalanceWei <= input.belowBalanceWei
    ) {
      fail("auto-recharge-invalid", "invalid balance threshold/target");
    }
  }
  return Object.freeze({
    version: 1 as const,
    chainId: input.chainId,
    assetId: input.assetId,
    maxPerPaymentWei: input.maxPerPaymentWei,
    maxTotalWei: input.maxTotalWei,
    maxPayments: input.maxPayments,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
    ...(input.belowBalanceWei !== undefined
      ? { belowBalanceWei: input.belowBalanceWei, targetBalanceWei: input.targetBalanceWei! }
      : {}),
  });
}
