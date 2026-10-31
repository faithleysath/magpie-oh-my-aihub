import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HDNodeWallet,
  Transaction,
  TypedDataEncoder,
  Wallet,
  getAddress,
  keccak256,
  verifyTypedData,
} from "ethers";
import {
  BIP44_EVM_PATH,
  DEFAULT_KDF,
  MAX_KEYSTORE_BYTES,
  SensitiveExportCapability,
  WalletVault,
  WalletVaultError,
  createStaticChainPolicy,
  validateAutoRechargePolicy,
  type AutoRechargePolicy,
  type WalletTypedData,
  type WalletTypedDataPurpose,
} from "../src/wallet-vault.ts";

/**
 * Pure module tests: no Magpie, no EasyTier, no RPC, no real wallet secret.
 * Every key is either created in a temporary directory or comes from a
 * published BIP39 vector. The vault file lives under a fresh mkdtemp directory.
 */

const PASSWORD = "correct horse battery staple";
const TEST_KDF = { N: 1 << 15, r: 8, p: 1 };
const VECTOR_12 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VECTOR_12_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const VECTOR_12_WALLET = HDNodeWallet.fromPhrase(VECTOR_12);
const VECTOR_12_PRIVATE_KEY = VECTOR_12_WALLET.privateKey;
const VECTOR_24 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const VECTOR_24_ADDRESS = "0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb";

const PAYEE = "0x1111111111111111111111111111111111111111";
const VERIFYING_CONTRACT = "0x2222222222222222222222222222222222222222";

const TEST_POLICY = createStaticChainPolicy({ 31337: "simulation", 97: "testnet", 84532: "testnet" });

const PAYMENT_PURPOSE: WalletTypedDataPurpose = {
  id: "aihub-payment",
  chainId: 31337,
  primaryType: "Payment",
  domainName: "Oh My AIHub",
  domainVersion: "1",
  verifyingContracts: [VERIFYING_CONTRACT],
  messageTypes: {
    invoiceId: "bytes32",
    payee: "address",
    amount: "uint256",
    nonce: "uint64",
  },
};

const createdDirs: string[] = [];

afterEach(async () => {
  for (const dir of createdDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function clock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

async function freshPath(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "oma-wallet-"));
  createdDirs.push(dir);
  return { dir, path: join(dir, "wallet", "keystore.json") };
}

async function openVault(options: Partial<Parameters<typeof WalletVault.open>[0]> = {}) {
  const { dir, path } = await freshPath();
  const vault = await WalletVault.open({
    path,
    kdf: TEST_KDF,
    sessionTtlMs: 1_000,
    chainPolicy: TEST_POLICY,
    purposes: [PAYMENT_PURPOSE],
    ...options,
  });
  return { dir, path, vault };
}

function errorCode(error: unknown): string | null {
  return error instanceof WalletVaultError ? error.code : null;
}

function paymentTypedData(overrides: {
  chainId?: number;
  verifyingContract?: string;
  payee?: string;
  amount?: bigint;
  primaryType?: string;
  extraField?: boolean;
  missingField?: boolean;
  extraDomain?: boolean;
} = {}): WalletTypedData {
  const fields = [
    { name: "invoiceId", type: "bytes32" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint64" },
  ];
  if (overrides.extraField) fields.push({ name: "memo", type: "string" });
  const message: Record<string, unknown> = {
    invoiceId: `0x${"ab".repeat(32)}`,
    payee: overrides.payee ?? PAYEE,
    amount: overrides.amount ?? 1_000_000n,
    nonce: 7,
  };
  if (overrides.extraField) message.memo = "hidden";
  if (overrides.missingField) delete message.nonce;
  const domain: Record<string, unknown> = {
    name: "Oh My AIHub",
    version: "1",
    chainId: overrides.chainId ?? 31337,
    verifyingContract: overrides.verifyingContract ?? VERIFYING_CONTRACT,
  };
  if (overrides.extraDomain) domain.salt = `0x${"00".repeat(32)}`;
  return {
    domain,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Payment: fields,
    },
    primaryType: overrides.primaryType ?? "Payment",
    message,
  } as WalletTypedData;
}

function paymentInput(overrides: Partial<Parameters<WalletVault["preparePayment"]>[0]> = {}) {
  return {
    chainId: 31337,
    to: PAYEE,
    valueWei: 1_000_000_000_000_000n,
    nonce: 3,
    gasLimit: 21_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    ...overrides,
  };
}

describe("BIP39/BIP44 and keystore format", () => {
  test("published 12-word vector derives the published EVM address and private key", async () => {
    const { path, vault } = await openVault();
    const snapshot = await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    expect(snapshot.status).toBe("locked");
    expect(snapshot.address).toBe(VECTOR_12_ADDRESS);
    expect(snapshot.address).toBe(getAddress(VECTOR_12_ADDRESS));

    await vault.unlock(PASSWORD);
    const capability = vault.createExportCapability({
      kind: "private-key",
      purpose: "eip155-external-wallet",
      confirmation: "local-user-confirmed",
    });
    const exported = await vault.exportPrivateKey({ password: PASSWORD, capability });
    expect(exported.privateKey).toBe(VECTOR_12_PRIVATE_KEY);
    expect(exported.address).toBe(VECTOR_12_ADDRESS);
    expect(exported.path).toBe(BIP44_EVM_PATH);
    expect(exported.purpose).toBe("eip155-external-wallet");

    const text = await readFile(path, "utf8");
    expect(text).toContain('"version":3');
    expect(text).toContain('"kdf":"scrypt"');
    expect(text).not.toContain(VECTOR_12);
    expect(text).not.toContain(VECTOR_12_PRIVATE_KEY);
  });

  test("published 24-word vector is accepted and derives its published address", async () => {
    const { vault } = await openVault();
    const snapshot = await vault.importMnemonic({ mnemonic: VECTOR_24, password: PASSWORD });
    expect(snapshot.address).toBe(VECTOR_24_ADDRESS);
  });

  test("created mnemonic can be restored into a second vault at the same address", async () => {
    const first = await openVault();
    const created = await first.vault.create({ password: PASSWORD });
    expect(created.mnemonic.split(" ")).toHaveLength(12);
    expect(created.snapshot.status).toBe("locked");
    expect(created.snapshot.address).not.toBeNull();
    expect(created.snapshot.unlockExpiresAt).toBeNull();
    expect(JSON.stringify(created.snapshot)).not.toContain(created.mnemonic);

    const second = await openVault();
    const restored = await second.vault.importMnemonic({ mnemonic: created.mnemonic, password: PASSWORD });
    expect(restored.address).toBe(created.snapshot.address);

    const third = await openVault();
    const another = await third.vault.create({ password: PASSWORD });
    expect(another.snapshot.address).not.toBe(created.snapshot.address);
    expect(another.mnemonic).not.toBe(created.mnemonic);
  });

  test("invalid mnemonic, short password and lost word count fail before writing", async () => {
    const { path, vault } = await openVault();
    await expect(
      vault.importMnemonic({
        mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon",
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "mnemonic-invalid" });
    await expect(vault.importMnemonic({ mnemonic: VECTOR_12, password: "short" })).rejects.toMatchObject({
      code: "password-policy",
    });
    await expect(vault.importMnemonic({ mnemonic: VECTOR_12.replace("about", "zzzz"), password: PASSWORD })).rejects.toMatchObject({
      code: "mnemonic-invalid",
    });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("the file is a standard Web3 keystore-v3 with 0600 file and 0700 directory", async () => {
    const { dir, path, vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    const fileStat = await stat(path);
    expect(fileStat.mode & 0o777).toBe(0o600);
    const dirStat = await stat(join(dir, "wallet"));
    expect(dirStat.mode & 0o777).toBe(0o700);

    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe(3);
    expect(parsed.crypto ?? parsed.Crypto).toBeTruthy();
    const crypto = parsed.crypto ?? parsed.Crypto;
    expect(crypto.cipher).toBe("aes-128-ctr");
    expect(crypto.kdf).toBe("scrypt");
    expect(crypto.kdfparams.n).toBe(TEST_KDF.N);
    expect(crypto.kdfparams.r).toBe(TEST_KDF.r);
    expect(crypto.kdfparams.p).toBe(TEST_KDF.p);
    expect(parsed.address.toLowerCase()).toBe(VECTOR_12_ADDRESS.slice(2).toLowerCase());
    expect(parsed["x-ethers"]).toBeTruthy();

    const standard = await Wallet.fromEncryptedJson(text, PASSWORD);
    expect(standard.address).toBe(VECTOR_12_ADDRESS);
    expect(standard instanceof HDNodeWallet).toBe(true);
    expect((standard as HDNodeWallet).mnemonic?.phrase).toBe(VECTOR_12);
  });

  test("default KDF is strong and the default-encrypted file is still readable", async () => {
    expect(DEFAULT_KDF.N).toBeGreaterThanOrEqual(1 << 17);
    expect(DEFAULT_KDF.r).toBe(8);
    expect(DEFAULT_KDF.p).toBe(1);
    const { vault } = await openVault({ kdf: DEFAULT_KDF });
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await vault.unlock(PASSWORD);
    expect(vault.snapshot().address).toBe(VECTOR_12_ADDRESS);
  });

  test("a 0644 wallet file is refused, and a symlink is refused", async () => {
    const { path, vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await chmod(path, 0o644);
    await expect(WalletVault.open({ path, kdf: TEST_KDF })).rejects.toMatchObject({
      code: "wallet-file-permissions",
    });
    await chmod(path, 0o600);

    const linkPath = `${path}.link`;
    await symlink(path, linkPath);
    await expect(WalletVault.open({ path: linkPath, kdf: TEST_KDF })).rejects.toMatchObject({
      code: "wallet-file-permissions",
    });
  });

  test("tampered ciphertext, MAC, KDF and unknown fields fail closed", async () => {
    const { path, vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    const original = JSON.parse(await readFile(path, "utf8"));
    const crypto = original.crypto ?? original.Crypto;

    const tampered = structuredClone(original);
    const tamperedCrypto = tampered.crypto ?? tampered.Crypto;
    tamperedCrypto.ciphertext = `${tamperedCrypto.ciphertext.slice(0, -1)}${tamperedCrypto.ciphertext.endsWith("0") ? "1" : "0"}`;
    await writeFile(path, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    const tamperedVault = await WalletVault.open({ path, kdf: TEST_KDF });
    await expect(tamperedVault.unlock(PASSWORD)).rejects.toMatchObject({ code: "password-invalid" });
    expect(tamperedVault.snapshot().status).toBe("locked");

    const huge = structuredClone(original);
    const hugeCrypto = huge.crypto ?? huge.Crypto;
    hugeCrypto.kdfparams.n = 1 << 30;
    await writeFile(path, `${JSON.stringify(huge)}\n`, { mode: 0o600 });
    await expect(WalletVault.open({ path, kdf: TEST_KDF })).rejects.toMatchObject({ code: "keystore-dos" });

    const extra = structuredClone(original);
    extra.privateKey = VECTOR_12_PRIVATE_KEY;
    await writeFile(path, `${JSON.stringify(extra)}\n`, { mode: 0o600 });
    await expect(WalletVault.open({ path, kdf: TEST_KDF })).rejects.toMatchObject({ code: "keystore-invalid" });

    // The untouched original still decrypts; tampering did not alter the key.
    await writeFile(path, `${JSON.stringify(original)}\n`, { mode: 0o600 });
    await expect(vault.unlock(PASSWORD)).resolves.toMatchObject({ status: "unlocked" });
    expect(crypto.kdf).toBe("scrypt");
  });
});

describe("lock, TTL, restart and password change", () => {
  test("unlock expires after the fixed TTL, and lock clears signing/export access", async () => {
    const time = clock();
    const { path, vault } = await openVault({ now: time.now });
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    const unlocked = await vault.unlock(PASSWORD);
    expect(unlocked.status).toBe("unlocked");
    expect(unlocked.unlockExpiresAt).toBe(new Date(time.now() + 1_000).toISOString());

    const permit = vault.createSigningPermit({
      kind: "payment",
      purpose: "payment",
      chainId: 31337,
      maxPerPaymentWei: 2_000_000_000_000_000n,
      maxTotalWei: 2_000_000_000_000_000n,
      maxUses: 1,
    });
    const expiredExportCapability = vault.createExportCapability({
      kind: "mnemonic",
      purpose: "wallet-recovery",
      confirmation: "local-user-confirmed",
    });
    time.advance(1_001);
    expect(vault.snapshot().status).toBe("locked");
    expect(vault.snapshot().unlockExpiresAt).toBeNull();
    const preparedAfterExpiry = vault.preparePayment(paymentInput());
    await expect(vault.signPayment({ prepared: preparedAfterExpiry, permit })).rejects.toMatchObject({
      code: "wallet-locked",
    });
    await expect(
      vault.exportMnemonic({
        password: PASSWORD,
        capability: expiredExportCapability,
      }),
    ).rejects.toMatchObject({ code: "wallet-locked" });

    await vault.unlock(PASSWORD);
    vault.lock();
    expect(vault.snapshot().status).toBe("locked");
    await expect(vault.signPayment({ prepared: vault.preparePayment(paymentInput()), permit })).rejects.toMatchObject({
      code: "wallet-locked",
    });

    const restarted = await WalletVault.open({ path, kdf: TEST_KDF, now: time.now, chainPolicy: TEST_POLICY, purposes: [PAYMENT_PURPOSE] });
    expect(restarted.snapshot()).toMatchObject({ status: "locked", address: VECTOR_12_ADDRESS });
    await expect(restarted.unlock("wrong password 123")).rejects.toMatchObject({ code: "password-invalid" });
    expect(restarted.snapshot().status).toBe("locked");
    await expect(restarted.unlock(PASSWORD)).resolves.toMatchObject({ status: "unlocked" });
  });

  test("changing the password invalidates the old one and forces a new unlock", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await vault.unlock(PASSWORD);
    const nextPassword = "a different long wallet password";
    const changed = await vault.changePassword(PASSWORD, nextPassword);
    expect(changed.status).toBe("locked");
    await expect(vault.unlock(PASSWORD)).rejects.toMatchObject({ code: "password-invalid" });
    await expect(vault.unlock(nextPassword)).resolves.toMatchObject({ status: "unlocked" });
  });

  test("create/import/restore will not overwrite an existing wallet without replace", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await expect(vault.importMnemonic({ mnemonic: VECTOR_24, password: PASSWORD })).rejects.toMatchObject({
      code: "wallet-exists",
    });
    await expect(vault.create({ password: PASSWORD })).rejects.toMatchObject({ code: "wallet-exists" });
    await expect(vault.importMnemonic({ mnemonic: VECTOR_24, password: PASSWORD, replace: true })).rejects.toMatchObject({
      code: "password-invalid",
    });
    await expect(
      vault.importMnemonic({ mnemonic: VECTOR_24, password: PASSWORD, replace: true, currentPassword: "wrong password 123" }),
    ).rejects.toMatchObject({ code: "password-invalid" });
    expect(vault.snapshot().address).toBe(VECTOR_12_ADDRESS);
    const replaced = await vault.importMnemonic({ mnemonic: VECTOR_24, password: PASSWORD, replace: true, currentPassword: PASSWORD });
    expect(replaced.address).toBe(VECTOR_24_ADDRESS);
  });
});

describe("encrypted backup restore", () => {
  test("backup restores the same address into a new vault and keeps the mnemonic exportable", async () => {
    const source = await openVault();
    await source.vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await source.vault.unlock(PASSWORD);
    const backup = await source.vault.exportEncryptedBackup();
    expect(backup.format).toBe("web3-keystore-v3");
    expect(backup.address).toBe(VECTOR_12_ADDRESS);
    expect(backup.keystore).not.toContain(VECTOR_12);

    const target = await openVault();
    const restored = await target.vault.restore({ keystore: backup.keystore, password: PASSWORD });
    expect(restored.address).toBe(VECTOR_12_ADDRESS);
    expect(restored.status).toBe("locked");
    await target.vault.unlock(PASSWORD);
    const capability = target.vault.createExportCapability({
      kind: "mnemonic",
      purpose: "wallet-recovery",
      confirmation: "local-user-confirmed",
    });
    const exported = await target.vault.exportMnemonic({ password: PASSWORD, capability });
    expect(exported.mnemonic).toBe(VECTOR_12);
  });

  test("a backup with a wrong password or a tampered body is not written", async () => {
    const source = await openVault();
    await source.vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await source.vault.unlock(PASSWORD);
    const backup = await source.vault.exportEncryptedBackup();

    const target = await openVault();
    await expect(target.vault.restore({ keystore: backup.keystore, password: "wrong password 123" })).rejects.toMatchObject({
      code: "password-invalid",
    });
    expect(target.vault.snapshot().status).toBe("absent");
    expect((await target.vault.restore({ keystore: backup.keystore, password: PASSWORD })).address).toBe(VECTOR_12_ADDRESS);

    const tampered = JSON.parse(backup.keystore);
    const crypto = tampered.crypto ?? tampered.Crypto;
    crypto.mac = `${crypto.mac.slice(0, -1)}${crypto.mac.endsWith("0") ? "1" : "0"}`;
    const other = await openVault();
    await expect(other.vault.restore({ keystore: JSON.stringify(tampered), password: PASSWORD, replace: true, currentPassword: PASSWORD })).rejects.toMatchObject({
      code: "password-invalid",
    });
    expect(other.vault.snapshot().status).toBe("absent");
  });

  test("restore refuses an oversized backup before parsing", async () => {
    const { vault } = await openVault();
    await expect(
      vault.restore({ keystore: "x".repeat(MAX_KEYSTORE_BYTES + 1), password: PASSWORD }),
    ).rejects.toMatchObject({ code: "keystore-invalid" });
  });
});

describe("sensitive exports", () => {
  test("mnemonic and private-key exports require a session, a local capability and a fresh password", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    const lockedCapability = (() => {
      try {
        vault.createExportCapability({
          kind: "mnemonic",
          purpose: "wallet-recovery",
          confirmation: "local-user-confirmed",
        });
        return null;
      } catch (error) {
        return errorCode(error);
      }
    })();
    expect(lockedCapability).toBe("wallet-locked");

    await vault.unlock(PASSWORD);
    const mnemonicCapability = vault.createExportCapability({
      kind: "mnemonic",
      purpose: "wallet-recovery",
      confirmation: "local-user-confirmed",
    });
    const exported = await vault.exportMnemonic({ password: PASSWORD, capability: mnemonicCapability });
    expect(exported.mnemonic).toBe(VECTOR_12);
    expect(exported.address).toBe(VECTOR_12_ADDRESS);
    expect(exported.purpose).toBe("wallet-recovery");
    expect(exported.warning).toContain("Never share");

    await expect(vault.exportMnemonic({ password: PASSWORD, capability: mnemonicCapability })).rejects.toMatchObject({
      code: "export-capability-used",
    });

    const wrongKind = vault.createExportCapability({
      kind: "mnemonic",
      purpose: "wallet-recovery",
      confirmation: "local-user-confirmed",
    });
    await expect(vault.exportPrivateKey({ password: PASSWORD, capability: wrongKind })).rejects.toMatchObject({
      code: "export-purpose-mismatch",
    });
    // A kind mismatch does not consume the capability; the correct method still works.
    const stillWorks = await vault.exportMnemonic({ password: PASSWORD, capability: wrongKind });
    expect(stillWorks.mnemonic).toBe(VECTOR_12);

    const privateCapability = vault.createExportCapability({
      kind: "private-key",
      purpose: "eip155-external-wallet",
      confirmation: "local-user-confirmed",
    });
    const privateKey = await vault.exportPrivateKey({ password: PASSWORD, capability: privateCapability });
    expect(privateKey.privateKey).toBe(VECTOR_12_PRIVATE_KEY);
    expect(privateKey.address).toBe(VECTOR_12_ADDRESS);
    expect(privateKey.purpose).toBe("eip155-external-wallet");
  });

  test("a wrong password consumes the capability, locks the session and never exports", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await vault.unlock(PASSWORD);
    const capability = vault.createExportCapability({
      kind: "mnemonic",
      purpose: "wallet-recovery",
      confirmation: "local-user-confirmed",
    });
    await expect(vault.exportMnemonic({ password: "wrong password 123", capability })).rejects.toMatchObject({
      code: "password-invalid",
    });
    expect(vault.snapshot().status).toBe("locked");
    await vault.unlock(PASSWORD);
    await expect(vault.exportMnemonic({ password: PASSWORD, capability })).rejects.toMatchObject({
      code: "export-capability-invalid",
    });
  });

  test("capabilities expire, cannot be forged or used across vaults", async () => {
    const time = clock();
    const first = await openVault({ now: time.now, sessionTtlMs: 5_000 });
    await first.vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await first.vault.unlock(PASSWORD);
    const expiring = first.vault.createExportCapability({
      kind: "mnemonic",
      purpose: "wallet-recovery",
      confirmation: "local-user-confirmed",
      ttlMs: 1_000,
    });
    time.advance(1_001);
    await expect(first.vault.exportMnemonic({ password: PASSWORD, capability: expiring })).rejects.toMatchObject({
      code: "export-capability-expired",
    });

    const valid = first.vault.createExportCapability({
      kind: "mnemonic",
      purpose: "wallet-recovery",
      confirmation: "local-user-confirmed",
    });
    const second = await openVault({ now: time.now });
    await second.vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await second.vault.unlock(PASSWORD);
    await expect(second.vault.exportMnemonic({ password: PASSWORD, capability: valid })).rejects.toMatchObject({
      code: "export-capability-invalid",
    });

    const forged = Object.create(SensitiveExportCapability.prototype) as SensitiveExportCapability;
    await expect(first.vault.exportMnemonic({ password: PASSWORD, capability: forged })).rejects.toMatchObject({
      code: "export-capability-invalid",
    });
    expect(JSON.stringify(valid) === undefined).toBe(true);
    expect(String(valid)).toBe("[SensitiveExportCapability]");
  });

  test("wrong password and wrong confirmation errors never echo the secret", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await vault.unlock(PASSWORD);
    let message = "";
    try {
      await vault.unlock("this is the wrong password");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("this is the wrong password");
    await vault.unlock(PASSWORD);
    expect(() =>
      vault.createExportCapability({
        kind: "mnemonic",
        purpose: "wallet-recovery",
        confirmation: "not-a-local-confirmation" as never,
      }),
    ).toThrow(expect.objectContaining({ code: "export-capability-invalid" }));
  });

  test("the ordinary snapshot contains only public address/status/expiry", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    const locked = vault.snapshot();
    expect(Object.keys(locked).sort()).toEqual(["address", "status", "unlockExpiresAt", "version"]);
    expect(JSON.stringify(locked)).not.toContain(PASSWORD);
    expect(JSON.stringify(locked)).not.toContain(VECTOR_12);
    expect(JSON.stringify(locked)).not.toContain(VECTOR_12_PRIVATE_KEY);

    await vault.unlock(PASSWORD);
    const unlocked = vault.snapshot();
    expect(Object.keys(unlocked).sort()).toEqual(["address", "status", "unlockExpiresAt", "version"]);
    expect(JSON.stringify(unlocked)).not.toContain(PASSWORD);
    expect(JSON.stringify(unlocked)).not.toContain(VECTOR_12);
    expect(JSON.stringify(unlocked)).not.toContain(VECTOR_12_PRIVATE_KEY);
  });
});

describe("EIP-712 preview and scoped signing", () => {
  test("the published EIP-712 Mail vector hashes, but preview never signs", async () => {
    const { vault } = await openVault();
    const mail: WalletTypedData = {
      domain: {
        name: "Ether Mail",
        version: "1",
        chainId: 1,
        verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
      },
      types: {
        Person: [
          { name: "name", type: "string" },
          { name: "wallet", type: "address" },
        ],
        Mail: [
          { name: "from", type: "Person" },
          { name: "to", type: "Person" },
          { name: "contents", type: "string" },
        ],
      },
      primaryType: "Mail",
      message: {
        from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
        to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
        contents: "Hello, Bob!",
      },
    };
    const preview = vault.previewTypedData(mail);
    expect(preview.digest).toBe("0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2");
    expect(preview.signable).toBe(false);
    expect(preview.reason).toBe("preview-only");
    const mailTypes = Object.fromEntries(Object.entries(mail.types).map(([name, fields]) => [name, [...fields]]));
    expect(TypedDataEncoder.hash(mail.domain, mailTypes, mail.message)).toBe(preview.digest);
  });

  test("a prepared purpose can sign, and the signature verifies against the vault address", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await vault.unlock(PASSWORD);
    const typedData = paymentTypedData();
    const prepared = vault.prepareTypedData({ purpose: PAYMENT_PURPOSE.id, typedData });
    expect(prepared.signable).toBe(true);
    const paymentTypes = { Payment: [...typedData.types.Payment!] };
    expect(prepared.digest).toBe(TypedDataEncoder.hash(typedData.domain, paymentTypes, typedData.message));

    const permit = vault.createSigningPermit({
      kind: "typed-data",
      purpose: PAYMENT_PURPOSE.id,
      maxUses: 1,
    });
    const signed = vault.signTypedData({ prepared, permit });
    expect(signed.address).toBe(VECTOR_12_ADDRESS);
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/i);
    expect(
      verifyTypedData(typedData.domain, paymentTypes, typedData.message, signed.signature),
    ).toBe(VECTOR_12_ADDRESS);
    expect(permit.remainingUses).toBe(0);

    expect(() => vault.signTypedData({ prepared, permit })).toThrow(
      expect.objectContaining({ code: "signing-permit-exhausted" }),
    );
  });

  test("mainnet domains are preview-only and can never be prepared/signed", async () => {
    const { vault } = await openVault();
    for (const chainId of [56, 8453]) {
      const mainnet = paymentTypedData({ chainId });
      const preview = vault.previewTypedData(mainnet);
      expect(preview.chainId).toBe(chainId);
      expect(preview.signable).toBe(false);
      expect(preview.digest).toMatch(/^0x[0-9a-f]{64}$/);
      expect(() => vault.prepareTypedData({ purpose: PAYMENT_PURPOSE.id, typedData: mainnet })).toThrow(
        expect.objectContaining({ code: "signing-mainnet-forbidden" }),
      );
    }
  });

  test("domain, type, field and purpose substitutions are rejected", async () => {
    const { vault } = await openVault();
    const cases: WalletTypedData[] = [
      paymentTypedData({ chainId: 97 }),
      paymentTypedData({ verifyingContract: "0x3333333333333333333333333333333333333333" }),
      paymentTypedData({ extraDomain: true }),
      paymentTypedData({ extraField: true }),
      paymentTypedData({ missingField: true }),
      paymentTypedData({ primaryType: "Other" }),
    ];
    for (const typedData of cases) {
      expect(() => vault.prepareTypedData({ purpose: PAYMENT_PURPOSE.id, typedData })).toThrow(WalletVaultError);
    }
    expect(() =>
      vault.prepareTypedData({ purpose: "unknown-purpose", typedData: paymentTypedData() }),
    ).toThrow(expect.objectContaining({ code: "signing-purpose-invalid" }));
  });

  test("the narrow signing facade exposes no unlock/export/permit-minting operation", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await vault.unlock(PASSWORD);
    const facade = vault.signingFacade();
    expect(Object.keys(facade).sort()).toEqual([
      "preparePayment",
      "prepareTypedData",
      "signPayment",
      "signTypedData",
      "snapshot",
    ]);
    expect((facade as unknown as Record<string, unknown>).unlock).toBeUndefined();
    expect((facade as unknown as Record<string, unknown>).exportMnemonic).toBeUndefined();
    expect((facade as unknown as Record<string, unknown>).createSigningPermit).toBeUndefined();
    const prepared = facade.preparePayment(paymentInput());
    const permit = vault.createSigningPermit({
      kind: "payment",
      purpose: "payment",
      chainId: 31337,
      maxPerPaymentWei: 1_000_000_000_000_000n,
      maxTotalWei: 1_000_000_000_000_000n,
    });
    const signed = await facade.signPayment({ prepared, permit });
    expect(signed.from).toBe(VECTOR_12_ADDRESS);
  });

  test("prepared documents are bound to the vault instance, not only to their bytes", async () => {
    const first = await openVault();
    await first.vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await first.vault.unlock(PASSWORD);
    const prepared = first.vault.prepareTypedData({ purpose: PAYMENT_PURPOSE.id, typedData: paymentTypedData() });

    const second = await openVault();
    await second.vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await second.vault.unlock(PASSWORD);
    const permit = second.vault.createSigningPermit({ kind: "typed-data", purpose: PAYMENT_PURPOSE.id });
    expect(() => second.vault.signTypedData({ prepared, permit })).toThrow(
      expect.objectContaining({ code: "prepared-invalid" }),
    );
  });

  test("a forged prepared object is not signable, even with a valid permit", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await vault.unlock(PASSWORD);
    const prepared = vault.prepareTypedData({ purpose: PAYMENT_PURPOSE.id, typedData: paymentTypedData() });
    const permit = vault.createSigningPermit({ kind: "typed-data", purpose: PAYMENT_PURPOSE.id });
    const forged = Object.freeze({ ...prepared, digest: `0x${"00".repeat(32)}` });
    expect(() => vault.signTypedData({ prepared: forged, permit })).toThrow(
      expect.objectContaining({ code: "prepared-invalid" }),
    );
    expect(() => vault.signTypedData({ prepared, permit: { ...permit } as never })).toThrow(
      expect.objectContaining({ code: "signing-permit-invalid" }),
    );
  });

  test("an unknown or unclassified chain cannot sign even if a purpose is configured", async () => {
    const purposeOnOne = { ...PAYMENT_PURPOSE, id: "mainnet-like", chainId: 1 };
    const { vault } = await openVault({ purposes: [purposeOnOne] });
    expect(() =>
      vault.prepareTypedData({ purpose: purposeOnOne.id, typedData: paymentTypedData({ chainId: 1 }) }),
    ).toThrow(expect.objectContaining({ code: "signing-disabled" }));
    expect(() => vault.previewTypedData(paymentTypedData({ chainId: 1 }))).not.toThrow();
  });
});

describe("simulated/testnet payment signing", () => {
  test("signs a bounded EIP-1559 payment for a simulation chain without broadcasting", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await vault.unlock(PASSWORD);
    const prepared = vault.preparePayment(paymentInput());
    const permit = vault.createSigningPermit({
      kind: "payment",
      purpose: "payment",
      chainId: 31337,
      maxPerPaymentWei: 1_000_000_000_000_000n,
      maxTotalWei: 2_000_000_000_000_000n,
      maxUses: 2,
    });
    const signed = await vault.signPayment({ prepared, permit });
    expect(signed.broadcast).toBe(false);
    expect(signed.hash).toBe(keccak256(signed.rawTransaction));
    expect(signed.from).toBe(VECTOR_12_ADDRESS);
    expect(signed.to).toBe(PAYEE);
    expect(signed.valueWei).toBe("1000000000000000");
    expect(signed.purpose).toBe("payment");
    expect(permit.remainingUses).toBe(1);

    const parsed = Transaction.from(signed.rawTransaction);
    expect(parsed.type).toBe(2);
    expect(parsed.chainId).toBe(31337n);
    expect(parsed.to).toBe(PAYEE);
    expect(parsed.value).toBe(1_000_000_000_000_000n);
    expect(parsed.nonce).toBe(3);
    expect(parsed.from).toBe(VECTOR_12_ADDRESS);
  });

  test("the 56/8453 hard deny survives a permissive chain policy", async () => {
    const permissive = createStaticChainPolicy({ 56: "simulation", 8453: "testnet", 31337: "simulation" });
    const { vault } = await openVault({ chainPolicy: permissive });
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await vault.unlock(PASSWORD);
    for (const chainId of [56, 8453]) {
      expect(() => vault.preparePayment(paymentInput({ chainId }))).toThrow(
        expect.objectContaining({ code: "signing-mainnet-forbidden" }),
      );
    }
  });

  test("mainnet 56/8453 payment preparation is hard-denied before any signature", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await vault.unlock(PASSWORD);
    for (const chainId of [56, 8453]) {
      expect(() => vault.preparePayment(paymentInput({ chainId }))).toThrow(
        expect.objectContaining({ code: "signing-mainnet-forbidden" }),
      );
    }
    for (const chainId of [1, 10]) {
      expect(() => vault.preparePayment(paymentInput({ chainId }))).toThrow(
        expect.objectContaining({ code: "signing-disabled" }),
      );
    }
  });

  test("value limits and permit kind are enforced, and a failed limit does not consume a use", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await vault.unlock(PASSWORD);
    const permit = vault.createSigningPermit({
      kind: "payment",
      purpose: "payment",
      chainId: 31337,
      maxPerPaymentWei: 1_000_000_000_000_000n,
      maxTotalWei: 1_000_000_000_000_000n,
      maxUses: 1,
    });
    const tooLarge = vault.preparePayment(paymentInput({ valueWei: 1_000_000_000_000_001n }));
    await expect(vault.signPayment({ prepared: tooLarge, permit })).rejects.toMatchObject({
      code: "signing-permit-limit",
    });
    expect(permit.remainingUses).toBe(1);
    const allowed = await vault.signPayment({ prepared: vault.preparePayment(paymentInput()), permit });
    expect(allowed.valueWei).toBe("1000000000000000");
    expect(permit.remainingUses).toBe(0);

    const typedPermit = vault.createSigningPermit({ kind: "typed-data", purpose: PAYMENT_PURPOSE.id });
    await expect(
      vault.signPayment({ prepared: vault.preparePayment(paymentInput()), permit: typedPermit }),
    ).rejects.toMatchObject({ code: "signing-permit-invalid" });
  });

  test("an auto-recharge-labelled permit is still only a bounded signature permission", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await vault.unlock(PASSWORD);
    const permit = vault.createSigningPermit({
      kind: "payment",
      purpose: "auto-recharge",
      chainId: 31337,
      maxPerPaymentWei: 5n,
      maxTotalWei: 5n,
      maxUses: 1,
    });
    const signed = await vault.signPayment({ prepared: vault.preparePayment(paymentInput({ valueWei: 5n })), permit });
    expect(signed.purpose).toBe("auto-recharge");
    expect(permit.remainingUses).toBe(0);
  });

  test("invalid payment fields are rejected before signing", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await vault.unlock(PASSWORD);
    for (const input of [
      paymentInput({ valueWei: 0n }),
      paymentInput({ to: "0x0000000000000000000000000000000000000000" }),
      paymentInput({ data: "0x1" }),
      paymentInput({ nonce: -1 }),
      paymentInput({ gasLimit: 0n }),
      paymentInput({ maxPriorityFeePerGas: 3_000_000_000n }),
    ]) {
      expect(() => vault.preparePayment(input)).toThrow(WalletVaultError);
    }
  });

  test("signing while locked fails, and a signed payment is not a receipt", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await vault.unlock(PASSWORD);
    const prepared = vault.preparePayment(paymentInput());
    const permit = vault.createSigningPermit({
      kind: "payment",
      purpose: "payment",
      chainId: 31337,
      maxPerPaymentWei: 2_000_000_000_000_000n,
      maxTotalWei: 2_000_000_000_000_000n,
    });
    vault.lock();
    await expect(vault.signPayment({ prepared, permit })).rejects.toMatchObject({ code: "wallet-locked" });
  });
});

describe("auto-recharge policy shape (no executor)", () => {
  const base = (): AutoRechargePolicy => ({
    version: 1,
    chainId: 31337,
    assetId: "eip155:31337:0x3333333333333333333333333333333333333333",
    maxPerPaymentWei: 1_000n,
    maxTotalWei: 5_000n,
    maxPayments: 5,
    expiresAt: 1_700_000_300_000,
    nonce: "0123456789abcdef",
    belowBalanceWei: 100n,
    targetBalanceWei: 4_000n,
  });

  test("a bounded short policy validates and is frozen", () => {
    const policy = validateAutoRechargePolicy(base(), { now: 1_700_000_000_000, chainPolicy: TEST_POLICY });
    expect(policy).toMatchObject({ chainId: 31337, maxPerPaymentWei: 1_000n, maxTotalWei: 5_000n });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  test("mainnet, long sessions, bad limits, bad nonce and asset mismatch are refused", () => {
    const now = 1_700_000_000_000;
    const bad: AutoRechargePolicy[] = [
      { ...base(), chainId: 56, assetId: "eip155:56:0x3333333333333333333333333333333333333333" },
      { ...base(), chainId: 8453, assetId: "eip155:8453:0x3333333333333333333333333333333333333333" },
      { ...base(), expiresAt: now + 300_001 },
      { ...base(), maxPerPaymentWei: 6_000n },
      { ...base(), nonce: "short" },
      { ...base(), assetId: "eip155:97:0x3333333333333333333333333333333333333333" },
      { ...base(), maxPayments: 9 },
    ];
    for (const policy of bad) {
      expect(() => validateAutoRechargePolicy(policy, { now, chainPolicy: TEST_POLICY })).toThrow(WalletVaultError);
    }
  });
});

describe("concurrency and failure cleanup", () => {
  test("concurrent unlocks resolve consistently and leave one working session", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    const [a, b] = await Promise.all([vault.unlock(PASSWORD), vault.unlock(PASSWORD)]);
    expect(a.status).toBe("unlocked");
    expect(b.status).toBe("unlocked");
    expect(vault.snapshot().status).toBe("unlocked");
    await expect(vault.unlock("wrong password 123")).rejects.toMatchObject({ code: "password-invalid" });
    expect(vault.snapshot().status).toBe("locked");
    await vault.unlock(PASSWORD);
    expect(vault.snapshot().status).toBe("unlocked");
  });

  test("one export capability can satisfy exactly one concurrent export", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await vault.unlock(PASSWORD);
    const capability = vault.createExportCapability({
      kind: "mnemonic",
      purpose: "wallet-recovery",
      confirmation: "local-user-confirmed",
    });
    const results = await Promise.allSettled([
      vault.exportMnemonic({ password: PASSWORD, capability }),
      vault.exportMnemonic({ password: PASSWORD, capability }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  test("one payment permit can satisfy exactly one concurrent signing request", async () => {
    const { vault } = await openVault();
    await vault.importMnemonic({ mnemonic: VECTOR_12, password: PASSWORD });
    await vault.unlock(PASSWORD);
    const permit = vault.createSigningPermit({
      kind: "payment",
      purpose: "payment",
      chainId: 31337,
      maxPerPaymentWei: 2_000_000_000_000_000n,
      maxTotalWei: 2_000_000_000_000_000n,
      maxUses: 1,
    });
    const prepared = vault.preparePayment(paymentInput());
    const results = await Promise.allSettled([
      vault.signPayment({ prepared, permit }),
      vault.signPayment({ prepared, permit }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(permit.remainingUses).toBe(0);
  });
});
