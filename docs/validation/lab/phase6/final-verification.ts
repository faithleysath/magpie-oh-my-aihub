// Final targeted patch: one minimal real-Magpie regression. LAB ONLY.
//
// Proves the two fixed behaviours against Magpie 0.1.2038:
//   A. the gateway keeps accepting AI calls while GET /v1/magpie/limit fails,
//      and that condition is a failed accounting check (export withdrawn),
//      never a healthy one;
//   B. a usage-log gap blocks reissue, survives a restart, and is cleared only
//      by an audited resolution that does not invent money.
//
//   MAGPIE_DATA=... MAGPIE_BIN=... MAGPIE_ADDR=127.0.0.1:3446 \
//   bun docs/validation/lab/phase6/final-verification.ts finallab
//
// It copies the lab's usage log aside and restores it before finishing, revokes
// the consumer, and never prints a secret.

import { copyFileSync, mkdtempSync, renameSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Magpie } from "../../../../plugin/src/magpie.ts";
import { Ledger } from "../../../../plugin/src/ledger.ts";
import { Provisioner } from "../../../../plugin/src/provisioner.ts";
import { priceSnapshot } from "../../../../plugin/src/pricing.ts";

const data = process.env.MAGPIE_DATA;
const bin = process.env.MAGPIE_BIN;
if (!data || !bin) throw new Error("set MAGPIE_DATA and MAGPIE_BIN to the isolated lab");
process.chdir(data);
const addr = process.env.MAGPIE_ADDR ?? "127.0.0.1:3446";
process.env.MAGPIE_ADDR = addr;
const id = process.argv[2] ?? "finallab";
const model = process.env.LAB_MODEL ?? "labmock/lab-model";
const usageLog = join(data, "usage.jsonl");
const backup = `${usageLog}.final-lab-backup`;

const magpie = new Magpie(bin);
const ledgerDir = mkdtempSync(join(tmpdir(), "phase6-final-"));
const ledgerPath = join(ledgerDir, "ledger.sqlite");
let ledger = new Ledger(ledgerPath);

function provisioner(): Provisioner {
  return new Provisioner(magpie, {
    ledger,
    prices: async (models) => priceSnapshot(await magpie.catalogModels(), models),
    usageLog: () => usageLog,
    drainMs: 300,
  });
}
let p = provisioner();

/** A call as a remote consumer makes it (loopback is trusted by Magpie). */
async function call(secret: string, prompt: number, completion: number): Promise<number> {
  const res = await fetch(`http://${addr}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      "X-Forwarded-For": "203.0.113.9",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
      lab_prompt_tokens: prompt,
      lab_completion_tokens: completion,
    }),
  });
  return res.status;
}

copyFileSync(usageLog, backup);
try {
  // --- A: the limit read fails while the gateway still serves --------------
  const issued = await p.ensure(id, { models: [model], capUsd: 1 });
  const secret = p.find(id)!.secret;
  console.log("ISSUED", JSON.stringify({ keyId: issued.keyId, capUsd: issued.capUsd, version: issued.priceVersion }));
  console.log("CALL_OK", await call(secret, 200_000, 50_000));

  // Make the limit endpoint unreachable for this key by pointing the plugin at
  // a closed port: the gateway keeps serving, the read cannot answer.
  const goodAddr = process.env.MAGPIE_ADDR;
  process.env.MAGPIE_ADDR = "127.0.0.1:9";
  let firstFailure: string | null = null;
  try {
    await p.checkConsumer(id);
    console.log("READ_FAILURE_CHECK", "UNEXPECTED: check reported health");
  } catch (e) {
    firstFailure = String((e as Error).message).slice(0, 120);
    console.log("READ_FAILURE_CHECK", "rejected:", firstFailure);
  }
  // The gateway itself still accepts a real AI call while the read is broken.
  console.log("CALL_DURING_OUTAGE", await call(secret, 1000, 100));
  process.env.MAGPIE_ADDR = goodAddr;

  const healthy = await p.checkConsumer(id);
  console.log("AFTER_RESTORE", JSON.stringify({ paused: healthy.paused?.reason ?? null, balance: healthy.ledger?.balanceUsd }));

  // --- B: a log gap blocks reissue, across a restart ------------------------
  const keyId = p.find(id)!.keyId;
  const beforeGap = await p.status(id);
  console.log("BEFORE_GAP", JSON.stringify({ consumed: beforeGap.ledger?.consumedUsd, balance: beforeGap.ledger?.balanceUsd }));
  const size = statSync(usageLog).size;
  truncateSync(usageLog, 0);
  let blocked: string | null = null;
  try {
    await p.reissue(id);
    console.log("REISSUE_WITH_GAP", "UNEXPECTED: reissue succeeded");
  } catch (e) {
    blocked = String((e as Error).message).slice(0, 140);
    console.log("REISSUE_WITH_GAP", "rejected:", blocked);
  }
  // Restart: close and reopen the ledger, build a fresh provisioner.
  ledger.close();
  ledger = new Ledger(ledgerPath);
  p = provisioner();
  let stillBlocked: string | null = null;
  try {
    await p.reissue(id);
    console.log("REISSUE_AFTER_RESTART", "UNEXPECTED: reissue succeeded");
  } catch (e) {
    stillBlocked = String((e as Error).message).slice(0, 120);
    console.log("REISSUE_AFTER_RESTART", "rejected:", stillBlocked);
  }
  const gaps = ledger.openGaps(id);
  console.log("OPEN_GAPS", JSON.stringify(gaps.map((g) => ({ occurrences: g.occurrences, reason: g.reason.slice(0, 60) }))));

  // The log coming back is not a resolution.
  writeFileSync(usageLog, "");
  let afterReappear: string | null = null;
  try {
    await p.reissue(id);
    console.log("REISSUE_AFTER_REAPPEAR", "UNEXPECTED: reissue succeeded");
  } catch (e) {
    afterReappear = String((e as Error).message).slice(0, 90);
    console.log("REISSUE_AFTER_REAPPEAR", "rejected:", afterReappear);
  }

  // An audited resolution unblocks it, at the recorded balance only.
  const balanceBefore = (await p.status(id)).ledger!.balanceUsd;
  await p.resolveUsageGap(id, {
    logId: gaps[0].logId,
    resolvedBy: "final-lab-operator",
    note: "lab log truncated on purpose; unbilled calls written off, no compensation",
  });
  const reissued = await p.reissue(id);
  console.log(
    "AFTER_RESOLUTION",
    JSON.stringify({
      capUsd: reissued.capUsd,
      balance: reissued.ledger?.balanceUsd,
      unchanged: Math.abs(reissued.capUsd - Math.max(balanceBefore, 0)) < 1e-9,
      sameSecret: p.find(id)!.secret === secret,
      openGaps: ledger.openGaps(id).length,
    }),
  );
  void keyId;
  void size;
} finally {
  await p.revoke(id).catch(() => {});
  ledger.close();
  // Put the lab's log back so the next experiment starts from a real file.
  renameSync(backup, usageLog);
}
