import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsoleInputError, createConsoleHandler, type ConsoleHandler, type ConsoleServerOptions } from "../src/console-server.ts";
import {
  WALLET_VAULT_ACTIONS,
  WALLET_VAULT_SENSITIVE_ACTIONS,
  WalletLocalError,
  WalletLocalService,
  type WalletLocalContext,
} from "../src/wallet-local-service.ts";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const PASSWORD = "correct horse battery staple";
const VECTOR = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const assetsDir = join(import.meta.dir, "..", "console");
const CSRF_HEADER = "X-Ohmyaihub-Request".replace(/Request$/, "CS" + "RF");

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-wallet-local-"));
  dirs.push(dir);
  return join(dir, "wallet", "keystore.json");
}
function context(sessionId = "a".repeat(64), isActive = () => true): WalletLocalContext {
  return { sessionId, isActive };
}
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "OK"; } catch (error) { return error instanceof WalletLocalError ? error.code : "OTHER"; }
}

describe("WalletLocalService lifecycle and reveal", () => {
  test("create/import/recover, status, lock and backup/restore stay local", async () => {
    const path = tempPath();
    const service = new WalletLocalService({ path });
    const ctx = context();
    const created = await service.action("wallet-vault-create", { password: PASSWORD }, ctx) as { wallet: any; mnemonic: string; backupRequired: boolean; warning: string };
    expect(created.mnemonic.split(" ")).toHaveLength(12);
    expect(created.backupRequired).toBe(true);
    expect(created.warning).toContain("唯一一次");
    expect(created.wallet.status).toBe("locked");
    expect(created.wallet.addressVerified).toBe(false);

    const status = await service.action("wallet-vault-status", {}, ctx) as { wallet: any };
    expect(JSON.stringify(status)).not.toContain(created.mnemonic);
    expect(status.wallet.addressVerified).toBe(false);

    await expect(service.action("wallet-vault-unlock", { password: PASSWORD }, ctx)).resolves.toMatchObject({
      wallet: { status: "unlocked", addressVerified: true, address: created.wallet.address },
    });
    const backup = await service.action("wallet-vault-backup", {}, ctx) as { keystore: string; address: string };
    expect(backup.keystore).not.toContain(created.mnemonic);
    expect(JSON.stringify(backup)).not.toContain(PASSWORD);

    await service.action("wallet-vault-lock", {}, ctx);
    expect((await service.action("wallet-vault-status", {}, ctx) as any).wallet.addressVerified).toBe(false);

    const restoredPath = tempPath();
    const restored = new WalletLocalService({ path: restoredPath });
    const restoredResult = await restored.action("wallet-vault-restore", { encryptedBackup: backup.keystore, password: PASSWORD }, ctx) as { wallet: any };
    expect(restoredResult.wallet.address).toBe(created.wallet.address);
    await restored.action("wallet-vault-unlock", { password: PASSWORD }, ctx);
    const imported = await restored.action("wallet-vault-import", { mnemonic: VECTOR, password: PASSWORD, replace: true, currentPassword: PASSWORD }, ctx) as { wallet: any };
    expect(imported.wallet.address).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  });

  test("reveal requires a fresh confirmation, session binding and password; grant is one-use", async () => {
    const path = tempPath();
    const service = new WalletLocalService({ path });
    const a = context("a".repeat(64));
    const b = context("b".repeat(64));
    await service.action("wallet-vault-import", { mnemonic: VECTOR, password: PASSWORD }, a);
    await service.action("wallet-vault-unlock", { password: PASSWORD }, a);

    const grant = await service.action("wallet-vault-reveal-authorize", {
      kind: "mnemonic",
      purpose: "wallet-recovery",
      confirmation: "local-user-confirmed",
    }, a) as { authorizationId: string; expiresAt: string };
    expect(grant.authorizationId).toMatch(/^[0-9a-f]{64}$/);
    expect(await codeOf(service.action("wallet-vault-reveal-mnemonic", { authorizationId: grant.authorizationId, password: PASSWORD }, b))).toBe("wallet-reveal-invalid");
    const revealed = await service.action("wallet-vault-reveal-mnemonic", { authorizationId: grant.authorizationId, password: PASSWORD }, a) as { mnemonic: string; address: string; purpose: string };
    expect(revealed.mnemonic).toBe(VECTOR);
    expect(revealed.address).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
    expect(revealed.purpose).toBe("wallet-recovery");
    expect(await codeOf(service.action("wallet-vault-reveal-mnemonic", { authorizationId: grant.authorizationId, password: PASSWORD }, a))).toBe("wallet-reveal-invalid");

    const privateGrant = await service.action("wallet-vault-reveal-authorize", {
      kind: "private-key",
      purpose: "eip155-external-wallet",
      confirmation: "local-user-confirmed",
    }, a) as { authorizationId: string };
    const privateResult = await service.action("wallet-vault-reveal-private-key", { authorizationId: privateGrant.authorizationId, password: PASSWORD }, a) as { privateKey: string; address: string; purpose: string };
    expect(privateResult.privateKey).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(privateResult.address).toBe(revealed.address);

    const staleGrant = await service.action("wallet-vault-reveal-authorize", {
      kind: "mnemonic", purpose: "wallet-recovery", confirmation: "local-user-confirmed",
    }, a) as { authorizationId: string };
    service.endSession(a.sessionId);
    expect((await service.action("wallet-vault-status", {}, a) as any).wallet.status).toBe("locked");
    expect(await codeOf(service.action("wallet-vault-reveal-mnemonic", { authorizationId: staleGrant.authorizationId, password: PASSWORD }, a))).toBe("wallet-reveal-invalid");
    await service.action("wallet-vault-unlock", { password: PASSWORD }, a);
    const lockGrant = await service.action("wallet-vault-reveal-authorize", {
      kind: "mnemonic", purpose: "wallet-recovery", confirmation: "local-user-confirmed",
    }, a) as { authorizationId: string };
    await service.action("wallet-vault-lock", {}, a);
    await expect(service.action("wallet-vault-reveal-authorize", {
      kind: "mnemonic", purpose: "wallet-recovery", confirmation: "local-user-confirmed",
    }, a)).rejects.toMatchObject({ code: "wallet-unlock-required" });
    await service.action("wallet-vault-unlock", { password: PASSWORD }, a);
    expect(await codeOf(service.action("wallet-vault-reveal-mnemonic", { authorizationId: lockGrant.authorizationId, password: PASSWORD }, a))).toBe("wallet-reveal-invalid");

    const sameMsGrant = await service.action("wallet-vault-reveal-authorize", {
      kind: "mnemonic", purpose: "wallet-recovery", confirmation: "local-user-confirmed",
    }, a) as { authorizationId: string };
    await service.action("wallet-vault-unlock", { password: PASSWORD }, a);
    expect(await codeOf(service.action("wallet-vault-reveal-mnemonic", { authorizationId: sameMsGrant.authorizationId, password: PASSWORD }, a))).toBe("wallet-reveal-invalid");

    const disposeGrant = await service.action("wallet-vault-reveal-authorize", {
      kind: "mnemonic", purpose: "wallet-recovery", confirmation: "local-user-confirmed",
    }, a) as { authorizationId: string };
    service.dispose();
    expect((await service.action("wallet-vault-status", {}, a) as any).wallet.status).toBe("locked");
    expect(await codeOf(service.action("wallet-vault-reveal-mnemonic", { authorizationId: disposeGrant.authorizationId, password: PASSWORD }, a))).toBe("wallet-reveal-invalid");
  });

  test("wrong password locks the vault and burns the grant; inactive session and TTL reject", async () => {
    let now = 1_700_000_000_000;
    const path = tempPath();
    const service = new WalletLocalService({ path, now: () => now });
    const a = context("a".repeat(64));
    await service.action("wallet-vault-import", { mnemonic: VECTOR, password: PASSWORD }, a);
    await service.action("wallet-vault-unlock", { password: PASSWORD }, a);
    const grant = await service.action("wallet-vault-reveal-authorize", {
      kind: "mnemonic", purpose: "wallet-recovery", confirmation: "local-user-confirmed",
    }, a) as { authorizationId: string };
    await expect(service.action("wallet-vault-reveal-mnemonic", { authorizationId: grant.authorizationId, password: "wrong password 123" }, a)).rejects.toMatchObject({
      code: "wallet-password-invalid",
    });
    expect((await service.action("wallet-vault-status", {}, a) as any).wallet.status).toBe("locked");
    await service.action("wallet-vault-unlock", { password: PASSWORD }, a);
    expect(await codeOf(service.action("wallet-vault-reveal-mnemonic", { authorizationId: grant.authorizationId, password: PASSWORD }, a))).toBe("wallet-reveal-invalid");

    const expiring = await service.action("wallet-vault-reveal-authorize", {
      kind: "mnemonic", purpose: "wallet-recovery", confirmation: "local-user-confirmed",
    }, a) as { authorizationId: string };
    now += 60_001;
    expect(await codeOf(service.action("wallet-vault-reveal-mnemonic", { authorizationId: expiring.authorizationId, password: PASSWORD }, a))).toBe("wallet-reveal-invalid");

    const inactive = context("c".repeat(64), () => false);
    expect(await codeOf(service.action("wallet-vault-unlock", { password: PASSWORD }, inactive))).toBe("wallet-session-required");
  });

  test("adapter re-checks server-owned session after KDF and never returns a late secret", async () => {
    const service = new WalletLocalService({ path: tempPath() });
    let active = true;
    const ctx: WalletLocalContext = { sessionId: "d".repeat(64), isActive: () => active };
    const create = service.action("wallet-vault-create", { password: PASSWORD }, ctx);
    active = false;
    await expect(create).rejects.toMatchObject({ code: "wallet-session-required" });
    expect((await service.action("wallet-vault-status", {}, ctx) as any).wallet.status).toBe("locked");
  });

  test("pending unlock cannot resurrect after endSession/dispose or an inactive context", async () => {
    for (const mode of ["end", "inactive", "dispose"] as const) {
      const service = new WalletLocalService({ path: tempPath() });
      const ctx: WalletLocalContext = { sessionId: "e".repeat(64), isActive: () => true };
      await service.action("wallet-vault-import", { mnemonic: VECTOR, password: PASSWORD }, ctx);
      const pending = service.action("wallet-vault-unlock", { password: PASSWORD }, ctx);
      if (mode === "end") service.endSession(ctx.sessionId);
      if (mode === "inactive") (ctx as { isActive?: () => boolean }).isActive = () => false;
      if (mode === "dispose") service.dispose();
      await expect(pending).rejects.toMatchObject({ code: "wallet-session-required" });
      expect((await service.status()).wallet.status).toBe("locked");
    }
  });

  test("endSession during create/backup/reveal never returns a late secret", async () => {
    // create: KDF must not publish a mnemonic after session end.
    const creating = new WalletLocalService({ path: tempPath() });
    const ctx = context("f".repeat(64));
    const createPending = creating.action("wallet-vault-create", { password: PASSWORD }, ctx);
    creating.endSession(ctx.sessionId);
    await expect(createPending).rejects.toMatchObject({ code: "wallet-session-required" });
    expect((await creating.status()).wallet.status).toBe("locked");

    // backup: return no ciphertext after session end.
    const backing = new WalletLocalService({ path: tempPath() });
    const backupCtx = context("1".repeat(64));
    await backing.action("wallet-vault-import", { mnemonic: VECTOR, password: PASSWORD }, backupCtx);
    await backing.action("wallet-vault-unlock", { password: PASSWORD }, backupCtx);
    const backupPending = backing.action("wallet-vault-backup", {}, backupCtx);
    backing.endSession(backupCtx.sessionId);
    await expect(backupPending).rejects.toBeInstanceOf(WalletLocalError);
    expect((await backing.status()).wallet.status).toBe("locked");

    // reveal: KDF must not publish plaintext after session end.
    const revealing = new WalletLocalService({ path: tempPath() });
    const revealCtx = context("2".repeat(64));
    await revealing.action("wallet-vault-import", { mnemonic: VECTOR, password: PASSWORD }, revealCtx);
    await revealing.action("wallet-vault-unlock", { password: PASSWORD }, revealCtx);
    const grant = await revealing.action("wallet-vault-reveal-authorize", {
      kind: "mnemonic", purpose: "wallet-recovery", confirmation: "local-user-confirmed",
    }, revealCtx) as { authorizationId: string };
    const revealPending = revealing.action("wallet-vault-reveal-mnemonic", { authorizationId: grant.authorizationId, password: PASSWORD }, revealCtx);
    revealing.endSession(revealCtx.sessionId);
    await expect(revealPending).rejects.toBeInstanceOf(WalletLocalError);
    expect((await revealing.status()).wallet.status).toBe("locked");
  });

  test("restore limit is UTF-8 bytes, not UTF-16 code units", async () => {
    const service = new WalletLocalService({ path: tempPath() });
    const ctx = context();
    await expect(
      service.action("wallet-vault-restore", { encryptedBackup: "😀".repeat(9_000), password: PASSWORD }, ctx),
    ).rejects.toMatchObject({ code: "wallet-invalid-input" });
  });

  test("input whitelist and safe error messages do not echo secrets", async () => {
    const service = new WalletLocalService({ path: tempPath() });
    const ctx = context();
    await expect(service.action("wallet-vault-create", { password: PASSWORD, unexpected: true }, ctx)).rejects.toMatchObject({
      code: "wallet-invalid-input",
    });
    await expect(service.action("wallet-vault-unlock", { password: PASSWORD, sessionId: "f".repeat(64) }, ctx)).rejects.toMatchObject({
      code: "wallet-invalid-input",
    });
    await expect(service.action("wallet-vault-import", { mnemonic: VECTOR, password: "short" }, ctx)).rejects.toMatchObject({
      code: "wallet-invalid-input",
    });
    await expect(service.action("wallet-vault-unlock", { password: "wrong password 123" }, ctx)).rejects.toMatchObject({
      code: "wallet-absent",
    });
    await expect(service.action("wallet-vault-restore", { encryptedBackup: "x".repeat(32 * 1024 + 1), password: PASSWORD }, ctx)).rejects.toMatchObject({
      code: "wallet-invalid-input",
    });
    try {
      await service.action("wallet-vault-import", { mnemonic: VECTOR, password: PASSWORD }, ctx);
      await service.action("wallet-vault-unlock", { password: "wrong password 123" }, ctx);
    } catch (error) {
      expect((error as Error).message).not.toContain("wrong password 123");
      expect((error as Error).message).not.toContain(VECTOR);
    }
  });
});

function badKeystoreCase(kind: "0644" | "corrupt" | "symlink"): { cwd: string; path: string } {
  const cwd = mkdtempSync(join(tmpdir(), "oma-wallet-bad-"));
  dirs.push(cwd);
  const dir = join(cwd, "oh-my-aihub", "wallet");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "keystore.json");
  if (kind === "symlink") {
    const target = join(dir, "target.json");
    writeFileSync(target, JSON.stringify({ version: 3 }), { mode: 0o600 });
    symlinkSync(target, path);
  } else {
    writeFileSync(path, kind === "corrupt" ? "{\"version\":3}" : JSON.stringify({ version: 3 }), { mode: kind === "0644" ? 0o644 : 0o600 });
  }
  return { cwd, path };
}

describe("B1 real subprocess: session end never constructs a bad adapter", () => {
  for (const kind of ["0644", "corrupt", "symlink"] as const) {
    test(`${kind} keystore + session end/logout stays alive`, () => {
      const bad = badKeystoreCase(kind);
      const servicePath = join(import.meta.dir, "..", "src", "wallet-local-service.ts");
      const serverPath = join(import.meta.dir, "..", "src", "console-server.ts");
      const assets = assetsDir;
      const script = `
        import { WalletLocalService, endWalletLocalSession } from ${JSON.stringify(servicePath)};
        import { createConsoleHandler } from ${JSON.stringify(serverPath)};
        const bad = new WalletLocalService({ path: ${JSON.stringify(bad.path)} });
        bad.endSession("${"a".repeat(64)}");
        await new Promise((r) => setTimeout(r, 20));
        const fake = {};
        const h = createConsoleHandler({
          assetsDir: ${JSON.stringify(assets)},
          state: async () => ({}),
          action: async () => ({}),
          allowedActions: [],
          onSessionEnd: (id) => endWalletLocalSession(fake, id),
        }, 39999);
        const issued = h.issueTicket();
        const ticket = new URLSearchParams(new URL(issued).hash.slice(1)).get("ticket");
        const headers = { host: "127.0.0.1:" + h.port, "content-type": "application/json", "X-Ohmyaihub-Request": "1", origin: h.origin, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };
        const session = await h.handle(new Request(h.origin + "/ui/session", { method: "POST", headers, body: JSON.stringify({ ticket }) }));
        const cookie = session.headers.get("set-cookie").split(";")[0];
        const csrf = (await session.json()).csrf;
        const logout = await h.handle(new Request(h.origin + "/ui/logout", { method: "POST", headers: { ...headers, cookie, "X-Ohmyaihub-CSRF": csrf }, body: "{}" }));
        console.log("logout", logout.status, "end-session-ok");
      `;
      const result = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: bad.cwd,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      expect(result.exitCode, stderr).toBe(0);
      expect(stdout).toContain("logout 200");
      expect(stdout).toContain("end-session-ok");
      expect(stderr).not.toContain("WalletVaultError");
    });
  }
});

// Real console transport: authenticate, CSRF, sensitive UUID tombstones and session binding.
const PORT = 39997;
interface BrowserSession { cookie: string; csrf: string; expiresAt: string }
function fixture(service: WalletLocalService, now: () => number) {
  const options: ConsoleServerOptions = {
    assetsDir,
    state: async () => service.status(),
    action: async (name, input, ctx) => {
      try { return await service.action(name, input, ctx); }
      catch (error) { if (error instanceof WalletLocalError) throw new ConsoleInputError(error.message); throw error; }
    },
    allowedActions: WALLET_VAULT_ACTIONS,
    sensitiveActions: WALLET_VAULT_SENSITIVE_ACTIONS,
    onSessionEnd: (sessionId) => service.endSession(sessionId),
  };
  return createConsoleHandler(options, PORT, { now });
}
function request(h: ConsoleHandler, path: string, options: {
  method?: string;
  body?: unknown;
  session?: BrowserSession;
  headers?: Record<string, string | null | undefined>;
  idempotencyKey?: string;
} = {}) {
  const method = options.method ?? "GET";
  const headers = new Headers({ host: `127.0.0.1:${h.port}`, "X-Ohmyaihub-Request": "1", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" });
  if (method === "POST") {
    headers.set("origin", h.origin);
    headers.set("content-type", "application/json");
    headers.set("idempotency-key", options.idempotencyKey ?? randomUUID());
  }
  if (options.session) {
    headers.set("cookie", options.session.cookie);
    headers.set(CSRF_HEADER, options.session.csrf);
  }
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(key);
    else if (value !== undefined) headers.set(key, value);
  }
  return new Request(`${h.origin}${path}`, {
    method, headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  } as RequestInit);
}
function ticket(h: ConsoleHandler): string {
  return new URLSearchParams(new URL(h.issueTicket()).hash.slice(1)).get("ticket")!;
}
async function open(h: ConsoleHandler): Promise<BrowserSession> {
  const response = await h.handle(request(h, "/ui/session", { method: "POST", body: { ticket: ticket(h) } }));
  expect(response.status).toBe(200);
  return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, ...await response.json() };
}
async function action(h: ConsoleHandler, session: BrowserSession, name: string, body: unknown, idempotencyKey?: string) {
  return h.handle(request(h, `/ui/api/action/${name}`, { method: "POST", session, body, idempotencyKey }));
}

describe("real console auth for wallet vault", () => {
  test("no session/no CSRF rejected; normal status has no secret", async () => {
    const service = new WalletLocalService({ path: tempPath() });
    const now = () => 1_700_000_000_000;
    const h = fixture(service, now);
    expect((await action(h, undefined as never, "wallet-vault-status", {})).status).toBe(401);
    const session = await open(h);
    expect((await action(h, session, "wallet-vault-status", {}, undefined)).status).toBe(200);
    expect((await h.handle(request(h, `/ui/api/action/wallet-vault-status`, { method: "POST", session, body: {}, headers: { [CSRF_HEADER]: null } }))).status).toBe(403);
    const state = await h.handle(request(h, "/ui/api/state", { session }));
    const text = await state.text();
    expect(text).toContain("wallet");
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("mnemonic");
    expect(text).not.toContain("privateKey");
  });

  test("create is sensitive: one UUID reveals once and duplicate never replays mnemonic", async () => {
    const service = new WalletLocalService({ path: tempPath() });
    const h = fixture(service, () => 1_700_000_000_000);
    const session = await open(h);
    const uuid = randomUUID();
    const first = await action(h, session, "wallet-vault-create", { password: PASSWORD }, uuid);
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.result.mnemonic.split(" ")).toHaveLength(12);
    const second = await action(h, session, "wallet-vault-create", { password: PASSWORD }, uuid);
    expect(second.status).toBe(409);
    expect(await second.text()).not.toContain(body.result.mnemonic);
    const status = await h.handle(request(h, "/ui/api/state", { session }));
    expect(await status.text()).not.toContain(body.result.mnemonic);

    await action(h, session, "wallet-vault-unlock", { password: PASSWORD });
    const backupUuid = randomUUID();
    const backup = await action(h, session, "wallet-vault-backup", {}, backupUuid);
    expect(backup.status).toBe(200);
    const backupText = await backup.text();
    expect(backupText).toContain('"keystore"');
    const backupReplay = await action(h, session, "wallet-vault-backup", {}, backupUuid);
    expect(backupReplay.status).toBe(409);
    expect(await backupReplay.text()).not.toContain('"keystore"');
  });

  test("console stop/lock tears down the local vault and grants", async () => {
    const service = new WalletLocalService({ path: tempPath() });
    const h = fixture(service, () => 1_700_000_000_000);
    const session = await open(h);
    await action(h, session, "wallet-vault-import", { mnemonic: VECTOR, password: PASSWORD });
    await action(h, session, "wallet-vault-unlock", { password: PASSWORD });
    const grant = (await (await action(h, session, "wallet-vault-reveal-authorize", {
      kind: "mnemonic", purpose: "wallet-recovery", confirmation: "local-user-confirmed",
    })).json()).result.authorizationId as string;
    const sessionId = session.cookie.split("=")[1]!;
    h.stop();
    expect((await service.status()).wallet.status).toBe("locked");
    expect(await codeOf(service.action("wallet-vault-reveal-mnemonic", { authorizationId: grant, password: PASSWORD }, context(sessionId)))).toBe("wallet-reveal-invalid");
  });

  test("wrong password locks; cross-session and expired grants reject; reauthorization succeeds once", async () => {
    let now = 1_700_000_000_000;
    const service = new WalletLocalService({ path: tempPath(), now: () => now });
    const h = fixture(service, () => now);
    const a = await open(h);
    await action(h, a, "wallet-vault-import", { mnemonic: VECTOR, password: PASSWORD });
    await action(h, a, "wallet-vault-unlock", { password: PASSWORD });
    const grant = (await (await action(h, a, "wallet-vault-reveal-authorize", {
      kind: "mnemonic", purpose: "wallet-recovery", confirmation: "local-user-confirmed",
    })).json()).result.authorizationId as string;

    const b = await open(h);
    const cross = await action(h, b, "wallet-vault-reveal-mnemonic", { authorizationId: grant, password: PASSWORD });
    expect(cross.status).toBe(400);
    expect(await cross.text()).not.toContain(VECTOR);

    const wrong = await action(h, a, "wallet-vault-reveal-mnemonic", { authorizationId: grant, password: "wrong password 123" });
    expect(wrong.status).toBe(400);
    const wrongText = await wrong.text();
    expect(wrongText).not.toContain(VECTOR);
    expect(wrongText).not.toContain("wrong password 123");
    expect((await (await action(h, a, "wallet-vault-status", {})).json()).result.wallet.status).toBe("locked");
    await action(h, a, "wallet-vault-unlock", { password: PASSWORD });
    expect((await action(h, a, "wallet-vault-reveal-mnemonic", { authorizationId: grant, password: PASSWORD })).status).toBe(400);

    const fresh = (await (await action(h, a, "wallet-vault-reveal-authorize", {
      kind: "mnemonic", purpose: "wallet-recovery", confirmation: "local-user-confirmed",
    })).json()).result.authorizationId as string;
    const okUuid = randomUUID();
    const ok = await action(h, a, "wallet-vault-reveal-mnemonic", { authorizationId: fresh, password: PASSWORD }, okUuid);
    expect(ok.status).toBe(200);
    expect((await ok.json()).result.mnemonic).toBe(VECTOR);
    const replay = await action(h, a, "wallet-vault-reveal-mnemonic", { authorizationId: fresh, password: PASSWORD }, okUuid);
    expect(replay.status).toBe(409);
    expect(await replay.text()).not.toContain(VECTOR);

    const expiring = (await (await action(h, a, "wallet-vault-reveal-authorize", {
      kind: "mnemonic", purpose: "wallet-recovery", confirmation: "local-user-confirmed",
    })).json()).result.authorizationId as string;
    now += 60_001;
    expect((await action(h, a, "wallet-vault-reveal-mnemonic", { authorizationId: expiring, password: PASSWORD })).status).toBe(400);

    const logoutGrant = (await (await action(h, a, "wallet-vault-reveal-authorize", {
      kind: "mnemonic", purpose: "wallet-recovery", confirmation: "local-user-confirmed",
    })).json()).result.authorizationId as string;
    const oldSessionId = a.cookie.split("=")[1]!;
    await h.handle(request(h, "/ui/logout", { method: "POST", session: a, body: {} }));
    expect((await action(h, a, "wallet-vault-reveal-mnemonic", { authorizationId: expiring, password: PASSWORD })).status).toBe(401);
    // Even a stale context that still claims to be active cannot reuse the
    // grant after the transport's session-end hook cleared it.
    expect(await codeOf(service.action("wallet-vault-reveal-mnemonic", { authorizationId: logoutGrant, password: PASSWORD }, context(oldSessionId)))).toBe("wallet-reveal-invalid");
  });
});
