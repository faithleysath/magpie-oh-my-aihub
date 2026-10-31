// Local console Service adapter for the isolated wallet vault.
//
// This is deliberately not a payment or P2P surface. It exposes only lifecycle,
// encrypted backup/restore and a session-bound, password-reauthenticated reveal
// grant. The existing console transport owns browser authentication, CSRF,
// idempotency and sensitive-response tombstones; this adapter never caches a
// secret and never writes one to disk.

import { randomBytes } from "node:crypto";
import { statePath } from "./paths.ts";
import {
  createStaticChainPolicy,
  WalletVault,
  WalletVaultError,
  type SensitiveExportKind,
  type SensitiveExportPurpose,
  type WalletSnapshot,
} from "./wallet-vault.ts";
import type { Service } from "./service.ts";

/** Exact console action allowlist; no arbitrary operation or P2P dispatch. */
export const WALLET_VAULT_ACTIONS = [
  "wallet-vault-status",
  "wallet-vault-create",
  "wallet-vault-import",
  "wallet-vault-restore",
  "wallet-vault-backup",
  "wallet-vault-unlock",
  "wallet-vault-lock",
  "wallet-vault-reveal-authorize",
  "wallet-vault-reveal-mnemonic",
  "wallet-vault-reveal-private-key",
] as const;

/** Responses containing plaintext or encrypted export material bypass the result cache. */
export const WALLET_VAULT_SENSITIVE_ACTIONS = [
  "wallet-vault-create",
  "wallet-vault-backup",
  "wallet-vault-reveal-mnemonic",
  "wallet-vault-reveal-private-key",
] as const;

export interface WalletLocalContext {
  sessionId: string;
  /** Canonical server-owned check used by the payment contract. */
  assertActive?: () => boolean;
  /** Compatibility alias for the vault adapter/tests. */
  isActive?: () => boolean;
}

export interface WalletLocalServiceOptions {
  path?: string;
  now?: () => number;
  sessionTtlMs?: number;
}

export class WalletLocalError extends Error {
  constructor(
    readonly code:
      | "wallet-invalid-input"
      | "wallet-session-required"
      | "wallet-unlock-required"
      | "wallet-password-invalid"
      | "wallet-locked"
      | "wallet-exists"
      | "wallet-absent"
      | "wallet-keystore-invalid"
      | "wallet-mnemonic-invalid"
      | "wallet-reveal-invalid"
      | "wallet-operation-failed",
    message: string,
  ) {
    super(message);
    this.name = "WalletLocalError";
  }
}

interface RevealGrant {
  consoleSessionId: string;
  kind: SensitiveExportKind;
  purpose: SensitiveExportPurpose;
  address: string;
  unlockExpiresAt: string | null;
  expiresAt: number;
  used: boolean;
}

const ACTION_SET = new Set<string>(WALLET_VAULT_ACTIONS);
const UUID_HEX = /^[0-9a-f]{64}$/;
const DEFAULT_REVEAL_TTL_MS = 60_000;
const MAX_REVEAL_TTL_MS = 120_000;
const MAX_PASSWORD_BYTES = 1024;
const MAX_MNEMONIC_CHARS = 4096;
// A real x-ethers keystore is ~1 KiB. Keep the restore input below the
// transport's 64 KiB JSON body (including JSON escaping), rather than granting
// the whole console a larger body limit for a weak port request.
const MAX_BACKUP_BYTES = 32 * 1024;

const owners = new WeakMap<Service, WalletLocalService>();

/** One adapter per Service data directory; existing host locking makes one owner. */
export function walletLocalService(service: Service): WalletLocalService {
  let value = owners.get(service);
  if (!value) {
    value = new WalletLocalService({ path: statePath("wallet", "keystore.json") });
    owners.set(service, value);
  }
  return value;
}

export async function walletLocalState(service: Service): Promise<{ wallet: WalletSnapshot }> {
  return (await walletLocalService(service).status()) as { wallet: WalletSnapshot };
}

export async function walletLocalAction(
  service: Service,
  name: string,
  input: Record<string, unknown>,
  context?: WalletLocalContext,
): Promise<unknown> {
  return walletLocalService(service).action(name, input, context);
}

/** Session end only uses an already-created owner; never constructs a vault. */
export function endWalletLocalSession(service: Service, sessionId: string): void {
  owners.get(service)?.endSession(sessionId);
}

/** Service/console stop only disposes an existing owner; never constructs one. */
export function disposeWalletLocalService(service: Service): void {
  owners.get(service)?.dispose();
}

export class WalletLocalService {
  private readonly vault: Promise<WalletVault>;
  private vaultInstance: WalletVault | null = null;
  private readonly now: () => number;
  private readonly grants = new Map<string, RevealGrant>();
  /**
   * Monotonic adapter lifecycle generation. Any session end, dispose, lock or
   * new vault-session action invalidates an unlock/create/backup/reveal that was
   * already inside KDF. JavaScript has no cancellation, so the completion path
   * compares this after awaiting and locks instead of publishing a late state.
   */
  private lifecycleEpoch = 0;

  constructor(options: WalletLocalServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.vault = WalletVault.open({
      path: options.path ?? statePath("wallet", "keystore.json"),
      now: this.now,
      ...(options.sessionTtlMs === undefined ? {} : { sessionTtlMs: options.sessionTtlMs }),
      // Normal service construction is testnet-only. 31337 requires the
      // explicit isolated test constructor in the core; this adapter never
      // exposes it from UI/env/config.
      chainPolicy: createStaticChainPolicy({ 97: "testnet", 84532: "testnet" }),
    });
    // A rejected open must stay observable to status/action(), but it must not
    // become an unhandled rejection when a session-end hook touches an owner or
    // when the process stops before the first status/action.
    void this.vault.then(
      (vault) => { this.vaultInstance = vault; },
      () => { /* status/action still await and map the rejection */ },
    );
  }

  async status(): Promise<{ wallet: WalletSnapshot }> {
    return { wallet: (await this.vault).snapshot() };
  }

  /**
   * Any console session end conservatively locks the one local vault and clears
   * every reveal grant. One browser logging out locks the local wallet for all
   * browser sessions; that is the deliberate local-security tradeoff.
   */
  endSession(_sessionId: string): void {
    this.lifecycleEpoch += 1;
    this.grants.clear();
    this.vaultInstance?.lock();
    void this.vault.then((vault) => vault.lock(), () => { /* handled open rejection */ });
  }

  /** Console/Service stop: lock and clear without constructing a new adapter. */
  dispose(): void {
    this.lifecycleEpoch += 1;
    this.grants.clear();
    this.vaultInstance?.dispose();
    void this.vault.then((vault) => vault.dispose(), () => { /* handled open rejection */ });
  }

  async action(name: string, input: Record<string, unknown>, context?: WalletLocalContext): Promise<unknown> {
    if (!ACTION_SET.has(name) || !isRecord(input)) {
      throw new WalletLocalError("wallet-invalid-input", "不支持的本地钱包操作");
    }
    try {
      switch (name) {
        case "wallet-vault-status":
          fields(input, []);
          return await this.status();
        case "wallet-vault-create":
          return await this.create(input, this.requireContext(context));
        case "wallet-vault-import":
          return await this.import(input, this.requireContext(context));
        case "wallet-vault-restore":
          return await this.restore(input, this.requireContext(context));
        case "wallet-vault-backup":
          return await this.backup(this.requireContext(context));
        case "wallet-vault-unlock":
          return await this.unlock(input, this.requireContext(context));
        case "wallet-vault-lock":
          return await this.lock(this.requireContext(context));
        case "wallet-vault-reveal-authorize":
          return await this.authorize(input, this.requireContext(context));
        case "wallet-vault-reveal-mnemonic":
          return await this.reveal("mnemonic", input, this.requireContext(context));
        case "wallet-vault-reveal-private-key":
          return await this.reveal("private-key", input, this.requireContext(context));
        default:
          throw new WalletLocalError("wallet-invalid-input", "不支持的本地钱包操作");
      }
    } catch (error) {
      if (error instanceof WalletLocalError) throw error;
      if (error instanceof WalletVaultError) throw mapVaultError(error);
      throw new WalletLocalError("wallet-operation-failed", "本地钱包操作失败");
    }
  }

  private async ensureLifecycle(epoch: number, context: WalletLocalContext, vault: WalletVault): Promise<void> {
    if (epoch !== this.lifecycleEpoch || !contextActive(context)) {
      vault.lock();
      this.grants.clear();
      throw new WalletLocalError("wallet-session-required", "当前本地浏览器会话已结束");
    }
  }

  private requireContext(context: WalletLocalContext | undefined): WalletLocalContext {
    if (!context || !UUID_HEX.test(context.sessionId) || !contextActive(context)) {
      throw new WalletLocalError("wallet-session-required", "需要当前已认证的本地浏览器会话");
    }
    return context;
  }

  private async create(input: Record<string, unknown>, context: WalletLocalContext): Promise<unknown> {
    fields(input, ["password", "strength"]);
    const epoch = ++this.lifecycleEpoch;
    this.grants.clear();
    const password = passwordInput(input.password);
    const strength = input.strength ?? 128;
    if (![128, 160, 192, 224, 256].includes(strength as number)) {
      throw new WalletLocalError("wallet-invalid-input", "助记词强度无效");
    }
    const vault = await this.vault;
    const result = await vault.create({ password, strength: strength as 128 | 160 | 192 | 224 | 256 });
    // The transport also checks this, but a non-transport caller must not get a
    // late mnemonic after its server-owned session ended during KDF.
    await this.ensureLifecycle(epoch, context, vault);
    // The response contains the one-time mnemonic and is a sensitive action at
    // the transport; this method does not retain it.
    return {
      wallet: result.snapshot,
      mnemonic: result.mnemonic,
      backupRequired: true,
      warning: "这是唯一一次显示助记词；请立即离线备份。不要粘贴到网站、聊天或日志中。",
    };
  }

  private async import(input: Record<string, unknown>, context: WalletLocalContext): Promise<unknown> {
    fields(input, ["mnemonic", "password", "replace", "currentPassword"]);
    const epoch = ++this.lifecycleEpoch;
    this.grants.clear();
    const mnemonic = textInput(input.mnemonic, MAX_MNEMONIC_CHARS, "助记词");
    const password = passwordInput(input.password);
    const replace = optionalBoolean(input.replace, "replace");
    const currentPassword = input.currentPassword === undefined ? undefined : passwordInput(input.currentPassword);
    if (replace === true && !currentPassword) {
      throw new WalletLocalError("wallet-invalid-input", "覆盖已有钱包需要当前密码");
    }
    const vault = await this.vault;
    const snapshot = await vault.importMnemonic({
      mnemonic,
      password,
      ...(replace === undefined ? {} : { replace }),
      ...(currentPassword === undefined ? {} : { currentPassword }),
    });
    await this.ensureLifecycle(epoch, context, vault);
    return { wallet: snapshot };
  }

  private async restore(input: Record<string, unknown>, context: WalletLocalContext): Promise<unknown> {
    fields(input, ["encryptedBackup", "password", "replace", "currentPassword"]);
    const epoch = ++this.lifecycleEpoch;
    this.grants.clear();
    const keystore = backupInput(input.encryptedBackup);
    const password = passwordInput(input.password);
    const replace = optionalBoolean(input.replace, "replace");
    const currentPassword = input.currentPassword === undefined ? undefined : passwordInput(input.currentPassword);
    if (replace === true && !currentPassword) {
      throw new WalletLocalError("wallet-invalid-input", "覆盖已有钱包需要当前密码");
    }
    const vault = await this.vault;
    const snapshot = await vault.restore({
      keystore,
      password,
      ...(replace === undefined ? {} : { replace }),
      ...(currentPassword === undefined ? {} : { currentPassword }),
    });
    await this.ensureLifecycle(epoch, context, vault);
    return { wallet: snapshot };
  }

  private async backup(context: WalletLocalContext): Promise<unknown> {
    const epoch = this.lifecycleEpoch;
    const vault = await this.vault;
    const result = await vault.exportEncryptedBackup();
    await this.ensureLifecycle(epoch, context, vault);
    return { ...result };
  }

  private async unlock(input: Record<string, unknown>, context: WalletLocalContext): Promise<unknown> {
    fields(input, ["password"]);
    const epoch = ++this.lifecycleEpoch;
    this.grants.clear();
    const password = passwordInput(input.password);
    const vault = await this.vault;
    const snapshot = await vault.unlock(password);
    await this.ensureLifecycle(epoch, context, vault);
    return { wallet: snapshot };
  }

  private async lock(context: WalletLocalContext): Promise<unknown> {
    this.lifecycleEpoch += 1;
    const vault = await this.vault;
    vault.lock();
    this.grants.clear();
    return { wallet: vault.snapshot() };
  }

  private async authorize(input: Record<string, unknown>, context: WalletLocalContext): Promise<unknown> {
    fields(input, ["kind", "purpose", "confirmation"]);
    if (input.confirmation !== "local-user-confirmed") {
      throw new WalletLocalError("wallet-invalid-input", "需要明确的本地用户确认");
    }
    const kind = input.kind;
    if (kind !== "mnemonic" && kind !== "private-key") {
      throw new WalletLocalError("wallet-invalid-input", "敏感导出类型无效");
    }
    const purpose = input.purpose;
    if (typeof purpose !== "string" || !validPurpose(kind, purpose)) {
      throw new WalletLocalError("wallet-invalid-input", "敏感导出用途无效");
    }
    const vault = await this.vault;
    const snapshot = vault.snapshot();
    if (snapshot.status !== "unlocked" || !snapshot.addressVerified) {
      throw new WalletLocalError("wallet-unlock-required", "请先解锁并验证钱包");
    }
    const authorizationId = randomBytes(32).toString("hex");
    const now = this.now();
    this.grants.set(authorizationId, {
      consoleSessionId: context.sessionId,
      kind,
      purpose,
      address: snapshot.address!,
      unlockExpiresAt: snapshot.unlockExpiresAt,
      expiresAt: now + DEFAULT_REVEAL_TTL_MS,
      used: false,
    });
    return {
      authorizationId,
      kind,
      expiresAt: new Date(now + DEFAULT_REVEAL_TTL_MS).toISOString(),
    };
  }

  private async reveal(kind: SensitiveExportKind, input: Record<string, unknown>, context: WalletLocalContext): Promise<unknown> {
    fields(input, ["authorizationId", "password"]);
    const authorizationId = textInput(input.authorizationId, 64, "授权编号");
    if (!UUID_HEX.test(authorizationId)) {
      throw new WalletLocalError("wallet-reveal-invalid", "敏感导出授权无效或已过期");
    }
    const password = passwordInput(input.password);
    const grant = this.grants.get(authorizationId);
    if (
      !grant ||
      grant.used ||
      grant.kind !== kind ||
      grant.consoleSessionId !== context.sessionId ||
      this.now() >= grant.expiresAt
    ) {
      throw new WalletLocalError("wallet-reveal-invalid", "敏感导出授权无效或已过期");
    }
    // Claim before the password/KDF operation: a wrong password or concurrent
    // duplicate cannot reuse the grant. Never retain a response.
    grant.used = true;
    this.grants.delete(authorizationId);
    const epoch = this.lifecycleEpoch;
    const vault = await this.vault;
    const snapshot = vault.snapshot();
    if (
      snapshot.status !== "unlocked" ||
      !snapshot.addressVerified ||
      snapshot.address !== grant.address ||
      snapshot.unlockExpiresAt !== grant.unlockExpiresAt
    ) {
      throw new WalletLocalError("wallet-unlock-required", "钱包已锁定或会话已变化，请重新解锁");
    }
    const capability = vault.createExportCapability({
      kind,
      purpose: grant.purpose,
      confirmation: "local-user-confirmed",
      ttlMs: Math.min(DEFAULT_REVEAL_TTL_MS, MAX_REVEAL_TTL_MS),
    });
    const result = kind === "mnemonic"
      ? await vault.exportMnemonic({ password, capability })
      : await vault.exportPrivateKey({ password, capability });
    // Defense in depth for future non-transport callers: never return plaintext
    // after the server-owned session ended or lifecycle changed during KDF.
    await this.ensureLifecycle(epoch, context, vault);
    return { ...result };
  }
}

function contextActive(context: WalletLocalContext): boolean {
  if (typeof context.assertActive === "function") return context.assertActive();
  return typeof context.isActive === "function" && context.isActive();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(input: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new WalletLocalError("wallet-invalid-input", "本地钱包操作包含不支持的字段");
  }
}

function textInput(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new WalletLocalError("wallet-invalid-input", `${label}格式无效`);
  }
  return value;
}

function passwordInput(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_PASSWORD_BYTES) {
    throw new WalletLocalError("wallet-invalid-input", "钱包密码格式无效");
  }
  return value;
}

function backupInput(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_BACKUP_BYTES ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new WalletLocalError("wallet-invalid-input", "加密备份格式无效或超过 32 KiB");
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new WalletLocalError("wallet-invalid-input", `${label}必须为 true 或 false`);
  return value;
}

function validPurpose(kind: SensitiveExportKind, purpose: string): purpose is SensitiveExportPurpose {
  if (kind === "mnemonic") return purpose === "wallet-recovery" || purpose === "wallet-migration";
  return purpose === "eip155-external-wallet" || purpose === "wallet-migration";
}

function mapVaultError(error: WalletVaultError): WalletLocalError {
  switch (error.code) {
    case "password-invalid":
      return new WalletLocalError("wallet-password-invalid", "钱包密码验证失败");
    case "wallet-locked":
    case "wallet-session-expired":
      return new WalletLocalError("wallet-locked", "钱包已锁定");
    case "wallet-exists":
      return new WalletLocalError("wallet-exists", "钱包已存在");
    case "wallet-absent":
      return new WalletLocalError("wallet-absent", "钱包不存在");
    case "mnemonic-invalid":
      return new WalletLocalError("wallet-mnemonic-invalid", "助记词无效");
    case "keystore-invalid":
    case "wallet-file-permissions":
    case "wallet-file-too-large":
    case "keystore-weak-kdf":
    case "keystore-dos":
      return new WalletLocalError("wallet-keystore-invalid", "钱包文件无效或不可安全读取");
    case "password-policy":
      return new WalletLocalError("wallet-invalid-input", "钱包密码不符合要求");
    case "signing-disabled":
    case "signing-mainnet-forbidden":
    case "signing-purpose-invalid":
    case "signing-permit-invalid":
    case "signing-permit-expired":
    case "signing-permit-exhausted":
    case "signing-permit-limit":
    case "prepared-invalid":
    case "typed-data-invalid":
    case "payment-invalid":
    case "auto-recharge-invalid":
      return new WalletLocalError("wallet-operation-failed", "本地钱包签名操作不可用");
    case "wallet-io":
      return new WalletLocalError("wallet-operation-failed", "本地钱包存储操作失败");
    default:
      return new WalletLocalError("wallet-operation-failed", "本地钱包操作失败");
  }
}
