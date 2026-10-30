import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWalletWizard, WizardApiError, type WizardApi, type WizardIO } from "../bin/wallet-wizard.ts";
import { formatTokenAmount, parseTokenAmount, rawForUsd, usdForRaw } from "../src/walletamount.ts";
import { createLab, ensureConsumer, PROVIDER_ID, RECIPIENT, type Lab } from "./support/wallet-lab.ts";
import { signDigest, TEST_PAYER } from "./support/signer.ts";
import type { WalletStatus } from "../src/wallet.ts";

/**
 * The wizard's own contract: exact amounts, no blind retry, no success without
 * evidence, and every network operation through the injected API.
 *
 * The API double below is a thin adapter over the real lab, so an intent created
 * by the wizard is a real `Wallet.requestIntent()` row and the signature is
 * verified by the production EIP-712 code. Only HTTP is fake.
 */

function scriptedIO(answers: string[]): { io: WizardIO; out: string[] } {
  const out: string[] = [];
  let next = 0;
  return {
    out,
    io: {
      print: (line) => out.push(line),
      prompt: async () => answers[next++] ?? "",
    },
  };
}

function labApi(lab: Lab): { api: WizardApi; calls: { method: string; path: string; body?: unknown }[] } {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const consumerIds = () => (lab as Lab & { _ids?: string[] })._ids ?? ["alice"];
  const api: WizardApi = {
    async get(path) {
      calls.push({ method: "GET", path });
      if (path === "/wallet") return { wallet: lab.wallet.statusLocal({ consumerIds: consumerIds() }) };
      if (path === "/status") return { consumers: lab.provisioner.all() };
      const intents = /^\/wallet\/intents\?consumerId=(.+)$/.exec(path);
      if (intents) return { intents: lab.store.intentsFor(decodeURIComponent(intents[1]!), 50) };
      throw new WizardApiError(`no GET ${path}`, 404);
    },
    async post(path, body) {
      calls.push({ method: "POST", path, body });
      if (path === "/wallet/intent") {
        return lab.wallet.requestIntent(body as Parameters<Lab["wallet"]["requestIntent"]>[0]);
      }
      if (path === "/wallet/intent/sign") {
        return lab.wallet.signIntent(body as Parameters<Lab["wallet"]["signIntent"]>[0]);
      }
      throw new WizardApiError(`no POST ${path}`, 404);
    },
  };
  return { api, calls };
}

describe("exact token amounts", () => {
  test("parses exactly and refuses what it cannot represent", () => {
    expect(parseTokenAmount("1", 6)).toEqual({ ok: true, raw: "1000000", normalised: "1", decimals: 6 });
    expect(parseTokenAmount("1.5", 6)).toEqual({ ok: true, raw: "1500000", normalised: "1.5", decimals: 6 });
    expect(parseTokenAmount("0.000001", 6)).toEqual({ ok: true, raw: "1", normalised: "0.000001", decimals: 6 });
    expect(parseTokenAmount("12.000000", 6)).toEqual({ ok: true, raw: "12000000", normalised: "12", decimals: 6 });
    for (const bad of ["1.0000001", "-1", "1e6", "1,5", "", " ", "0x10", "1.2.3"]) {
      expect(parseTokenAmount(bad, 6).ok).toBe(false);
    }
    expect(parseTokenAmount("1", 0)).toEqual({ ok: true, raw: "1", normalised: "1", decimals: 0 });
    expect(parseTokenAmount("1.0", 0).ok).toBe(false);
  });

  test("formats and round-trips without floats", () => {
    expect(formatTokenAmount("1", 18)).toBe("0.000000000000000001");
    expect(formatTokenAmount("1000000", 6)).toBe("1");
    expect(formatTokenAmount("1500000", 6)).toBe("1.5");
    expect(formatTokenAmount("0", 6)).toBe("0");
    for (const [text, decimals] of [["1", 6], ["0.123456", 6], ["123.000001", 18]] as const) {
      const parsed = parseTokenAmount(text, decimals);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(formatTokenAmount(parsed.raw, decimals)).toBe(text.replace(/\.0+$/, ""));
    }
  });

  test("the USD helper reports whether it was exact instead of rounding quietly", () => {
    const exact = rawForUsd({ usd: 1, decimals: 6, nanosPerToken: "1000000000" });
    expect(exact.raw).toBe("1000000");
    expect(exact.exact).toBe(true);

    // 1 USD at 3 nanos per token cannot be represented in whole tokens.
    const inexact = rawForUsd({ usd: 1, decimals: 0, nanosPerToken: "3" });
    expect(inexact.exact).toBe(false);
    expect(inexact.raw).toBe("333333333");
    expect(inexact.note).toContain("cannot represent");

    expect(usdForRaw({ raw: "1000000", decimals: 6, nanosPerToken: "1000000000" })).toBeCloseTo(1, 9);
    expect(usdForRaw({ raw: "1500000", decimals: 6, nanosPerToken: "1000000000" })).toBeCloseTo(1.5, 9);
  });
});

describe("wallet wizard", () => {
  test("happy path: exact request, real signature, then success only with evidence", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      (lab as Lab & { _ids?: string[] })._ids = ["alice"];
      const { api, calls } = labApi(lab);
      const out: string[] = [];
      const io: WizardIO = {
        print: (line) => out.push(line),
        prompt: async (question) => {
          if (question.startsWith("Signature")) return signDigest(lab.store.allIntents()[0]!.digest!);
          if (question.startsWith("Payer")) return TEST_PAYER;
          return "";
        },
      };
      let paid = false;

      const code = await runWalletWizard({
        api,
        io,
        argv: ["--consumer", "alice", "--provider", PROVIDER_ID, "--chain", "97", "--amount", "1", "--yes", "--ttl", "3600"],
        attempts: 3,
        sleep: async () => {},
        evidence: async () => {
          // Once, after the signature is recorded, the consumer pays. The
          // wizard's evidence callback is the only thing that moves the chain.
          const intent = lab.store.intentsFor("alice", 1)[0];
          if (intent && !paid) {
            paid = true;
            lab.chainFor(97).transfer({ from: TEST_PAYER, to: RECIPIENT, amount: BigInt(intent.expectedAmountRaw) });
            lab.chainFor(97).mineN(20);
            await lab.scan(97);
          }
          return lab.viewInput();
        },
      });

      expect(code).toBe(0);
      const intentPosts = calls.filter((c) => c.method === "POST" && c.path === "/wallet/intent");
      expect(intentPosts).toHaveLength(1);
      expect((intentPosts[0]!.body as any).amountRaw).toBe("1000000");
      expect((intentPosts[0]!.body as any).chainId).toBe(97);
      expect((intentPosts[0]!.body as any).providerId).toBe(PROVIDER_ID);
      expect(calls.some((c) => c.method === "POST" && c.path === "/wallet/intent/sign")).toBe(true);

      const text = out.join("\n");
      expect(text).toContain("raw 1000000 base units");
      expect(text).toContain("Send exactly");
      expect(text).toContain("Done: the credit is applied to the key");
      expect(text).not.toContain("Nothing is lost");
      // The real `/wallet/intent` response carries typedData at the top level.
      expect(text).toContain('"primaryType": "DepositIntent"');
      expect(text).toContain('"expectedAmountRaw": "1000000"');
      expect(text).toContain(`"invoiceId": "${lab.store.allIntents()[0]!.invoiceId}"`);
      expect(text).toContain("digest 0x");
      expect(text).not.toContain("\n{}\n");
      const typed = JSON.parse(text.slice(text.indexOf("{"), text.indexOf("digest 0x")));
      expect(typed.message.expectedAmountRaw).toBe("1000000");
      expect(typed.domain.chainId).toBe(97);
      expect(lab.store.allIntents()).toHaveLength(1);
    } finally {
      lab.close();
    }
  });

  test("an existing pending request is listed and no second one is created", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      const existing = lab.request({ consumerId: "alice", chainId: 97, amountRaw: "1000000" });
      const { api, calls } = labApi(lab);
      const { io, out } = scriptedIO(["n"]);

      const code = await runWalletWizard({
        api,
        io,
        argv: ["--consumer", "alice", "--provider", PROVIDER_ID, "--chain", "97", "--amount", "1", "--yes"],
        sleep: async () => {},
      });

      expect(code).toBe(1);
      expect(lab.store.allIntents()).toHaveLength(1);
      expect(calls.some((c) => c.method === "POST" && c.path === "/wallet/intent")).toBe(false);
      expect(out.join("\n")).toContain(existing.intent.invoiceId);
      expect(out.join("\n")).toContain("ambiguous");
    } finally {
      lab.close();
    }
  });

  test("an unknown POST result stops without a blind retry", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      const { api, calls } = labApi(lab);
      const failing: WizardApi = {
        get: api.get,
        post: async (path, body) => {
          if (path === "/wallet/intent") {
            calls.push({ method: "POST", path, body });
            throw new WizardApiError("socket timeout", null);
          }
          return api.post(path, body);
        },
      };
      const { io, out } = scriptedIO([]);

      const code = await runWalletWizard({
        api: failing,
        io,
        argv: ["--consumer", "alice", "--provider", PROVIDER_ID, "--chain", "97", "--amount", "1", "--yes"],
        sleep: async () => {},
      });

      expect(code).toBe(3);
      expect(calls.filter((c) => c.method === "POST" && c.path === "/wallet/intent")).toHaveLength(1);
      expect(out.join("\n")).toContain("Do NOT retry blindly");
      expect(lab.store.allIntents()).toHaveLength(0);
    } finally {
      lab.close();
    }
  });

  test("without host evidence the wizard refuses to call the key usable", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      (lab as Lab & { _ids?: string[] })._ids = ["alice"];
      const { api } = labApi(lab);
      const out: string[] = [];
      const io: WizardIO = {
        print: (line) => out.push(line),
        prompt: async (question) => {
          if (question.startsWith("Signature")) return signDigest(lab.store.allIntents()[0]!.digest!);
          if (question.startsWith("Payer")) return TEST_PAYER;
          return "";
        },
      };

      const code = await runWalletWizard({
        api,
        io,
        argv: ["--consumer", "alice", "--provider", PROVIDER_ID, "--chain", "97", "--amount", "1", "--yes"],
        attempts: 2,
        sleep: async () => {},
      });

      expect(code).toBe(1);
      const text = out.join("\n");
      expect(text).toContain("key usable: no — credit not proven applied");
      expect(text).not.toContain("Done:");
      expect(text).not.toContain("key usable: yes");
    } finally {
      lab.close();
    }
  });

  test("a paused consumer is not silently sent more credit", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      lab.ledger.setPaused("alice", "price-mismatch");
      await lab.provisioner.pauseForChain("alice", "price-mismatch");
      const { api, calls } = labApi(lab);
      const { io, out } = scriptedIO(["n"]);

      const code = await runWalletWizard({
        api,
        io,
        argv: ["--consumer", "alice", "--provider", PROVIDER_ID, "--chain", "97", "--amount", "1", "--yes"],
        sleep: async () => {},
      });

      expect(code).toBe(1);
      expect(calls.some((c) => c.method === "POST" && c.path === "/wallet/intent")).toBe(false);
      const text = out.join("\n");
      expect(text).toContain("paused");
      expect(text).toContain("does not unpause");
    } finally {
      lab.close();
    }
  });

  test("there is no default chain and no silently chosen provider", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      const { api, calls } = labApi(lab);

      const noChain = await runWalletWizard({
        api,
        io: scriptedIO([]).io,
        argv: ["--consumer", "alice", "--provider", PROVIDER_ID, "--amount", "1", "--yes", "--non-interactive"],
        sleep: async () => {},
      });
      expect(noChain).toBe(2);
      expect(calls.some((c) => c.method === "POST")).toBe(false);

      const noProvider = await runWalletWizard({
        api,
        io: scriptedIO([]).io,
        argv: ["--consumer", "alice", "--chain", "97", "--amount", "1", "--yes", "--non-interactive"],
        sleep: async () => {},
      });
      expect(noProvider).toBe(2);
      expect(calls.some((c) => c.method === "POST")).toBe(false);
      expect(lab.store.allIntents()).toHaveLength(0);
    } finally {
      lab.close();
    }
  });

  test("an unsigned request is a success that says 'awaiting signature', and resume works", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      (lab as Lab & { _ids?: string[] })._ids = ["alice"];
      const { api, calls } = labApi(lab);

      const createCode = await runWalletWizard({
        api,
        io: scriptedIO([]).io,
        argv: ["--consumer", "alice", "--provider", PROVIDER_ID, "--chain", "97", "--amount", "1", "--yes", "--non-interactive"],
        sleep: async () => {},
      });
      expect(createCode).toBe(0);
      const intent = lab.store.allIntents()[0]!;
      expect(intent.status).toBe("requested");
      expect(calls.some((c) => c.method === "POST" && c.path === "/wallet/intent/sign")).toBe(false);

      // Resume without a signature: still awaiting, still a success, and the
      // typed data is rebuilt with the production EIP-712 code (not empty).
      const out: string[] = [];
      const resumeCode = await runWalletWizard({
        api,
        io: { print: (l) => out.push(l), prompt: async () => "" },
        argv: ["--consumer", "alice", "--invoice", intent.invoiceId, "--non-interactive"],
        sleep: async () => {},
      });
      expect(resumeCode).toBe(0);
      const text = out.join("\n");
      expect(text).toContain("AWAITING SIGNATURE");
      expect(text).toContain('"primaryType": "DepositIntent"');
      expect(text).toContain('"expectedAmountRaw": "1000000"');
      expect(text).toContain("digest 0x");

      // Resume with the real signature (from a file) and host evidence.
      const dir = mkdtempSync(join(tmpdir(), "wizard-sig-"));
      const sigPath = join(dir, "signature.json");
      writeFileSync(sigPath, JSON.stringify({ signature: signDigest(intent.digest!), payerAddress: TEST_PAYER }));
      let paid = false;
      const signedOut: string[] = [];
      const signedCode = await runWalletWizard({
        api,
        io: { print: (l) => signedOut.push(l), prompt: async () => "" },
        argv: ["--consumer", "alice", "--invoice", intent.invoiceId, "--signature-file", sigPath, "--non-interactive"],
        attempts: 2,
        sleep: async () => {},
        evidence: async () => {
          if (!paid) {
            paid = true;
            lab.chainFor(97).transfer({ from: TEST_PAYER, to: RECIPIENT, amount: 1_000_000n });
            lab.chainFor(97).mineN(20);
            await lab.scan(97);
          }
          return lab.viewInput();
        },
      });
      expect(signedCode).toBe(0);
      expect(signedOut.join("\n")).toContain("Done: the credit is applied to the key");
      expect(lab.store.intentsFor("alice", 1)[0]!.payerAddress!.toLowerCase()).toBe(TEST_PAYER.toLowerCase());
    } finally {
      lab.close();
    }
  });

  test("a signature file works for a new request too", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      (lab as Lab & { _ids?: string[] })._ids = ["alice"];
      const { api, calls } = labApi(lab);
      const dir = mkdtempSync(join(tmpdir(), "wizard-sig2-"));
      const sigPath = join(dir, "s.txt");

      // The signature cannot exist before the request, so create it first, then
      // resume from the file. This is the documented two-step non-interactive use.
      const createCode = await runWalletWizard({
        api,
        io: scriptedIO([]).io,
        argv: ["--consumer", "alice", "--provider", PROVIDER_ID, "--chain", "97", "--amount", "1", "--yes", "--non-interactive"],
        sleep: async () => {},
      });
      expect(createCode).toBe(0);
      const intent = lab.store.allIntents()[0]!;
      writeFileSync(sigPath, signDigest(intent.digest!));
      let paid = false;
      const code = await runWalletWizard({
        api,
        io: scriptedIO([]).io,
        argv: ["--consumer", "alice", "--invoice", intent.invoiceId, "--signature-file", sigPath, "--payer", TEST_PAYER, "--non-interactive"],
        attempts: 2,
        sleep: async () => {},
        evidence: async () => {
          if (!paid) {
            paid = true;
            lab.chainFor(97).transfer({ from: TEST_PAYER, to: RECIPIENT, amount: 1_000_000n });
            lab.chainFor(97).mineN(20);
            await lab.scan(97);
          }
          return lab.viewInput();
        },
      });
      expect(code).toBe(0);
      expect(calls.filter((c) => c.method === "POST" && c.path === "/wallet/intent/sign")).toHaveLength(1);
    } finally {
      lab.close();
    }
  });

  test("a disabled wallet is explained instead of producing a request", async () => {
    const calls: string[] = [];
    const offline: WizardApi = {
      get: async (path) => {
        calls.push(path);
        if (path === "/wallet") {
          const wallet = { registry: { networks: [], assets: [] }, receiving: [], disabled: true } as unknown as WalletStatus;
          return { wallet };
        }
        throw new Error("unexpected");
      },
      post: async () => {
        throw new Error("unexpected");
      },
    };
    const { io, out } = scriptedIO([]);
    const code = await runWalletWizard({ api: offline, io, argv: ["--consumer", "alice"], sleep: async () => {} });
    expect(code).toBe(2);
    expect(out.join("\n")).toContain("disabled");
    expect(calls).toEqual(["/wallet"]);
  });
});
