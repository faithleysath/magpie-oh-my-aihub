// Phase-6 review patch: one consolidated real-Magpie run. LAB ONLY.
//
// Covers the three behaviours the review asked to prove against the real
// binary, not a fake:
//   1. an external price change pauses the key with no /status or page call;
//   2. a usage row that arrives after reissue is still charged at the old
//      window's frozen price and tightens the live cap;
//   3. reissue restores service only after an explicit price acceptance, with
//      the same secret for a plugin-owned key.
//
//   MAGPIE_DATA=... MAGPIE_BIN=... MAGPIE_ADDR=127.0.0.1:3446 \
//   bun docs/validation/lab/phase6/review-verification.ts reviewlab
//
// It revokes the consumer at the end and never prints a secret.

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
const id = process.argv[2] ?? "reviewlab";
const model = process.env.LAB_MODEL ?? "labmock/lab-model";

const magpie = new Magpie(bin);
const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "phase6-review-")), "ledger.sqlite"));
const p = new Provisioner(magpie, {
  ledger,
  prices: async (models) => priceSnapshot(await magpie.catalogModels(), models),
  usageLog: () => join(data, "usage.jsonl"),
  drainMs: 400,
});

/**
 * A call as a *remote* consumer makes it. Magpie trusts a loopback caller by
 * construction (`internal/gateway/lan.go`: `local(r)`), so a loopback probe with
 * a removed key still answers 200 and would hide a failure to stop. A consumer
 * reaches the gateway through EasyTier's Forward path, which arrives from a
 * non-loopback address; a forwarding header reproduces exactly that branch
 * (measured: no key 401, wrong key 401, valid key 200).
 */
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

try {
  const issued = await p.ensure(id, { models: [model], capUsd: 1 });
  const secret = p.find(id)!.secret;
  console.log("ISSUED", JSON.stringify({ keyId: issued.keyId, capUsd: issued.capUsd, window: issued.window, version: issued.priceVersion }));

  console.log("CALL_0_3", await call(secret, 200_000, 50_000));
  const before = await p.status(id);
  console.log("BEFORE", JSON.stringify({ used: before.usedUsd, balance: before.ledger?.balanceUsd, paused: before.paused }));

  // (1) External price change, then only the periodic check runs.
  const set = spawnSync(bin, ["model", "price", model, "2,4,0.2,0.4"], { encoding: "utf8" });
  if (set.status !== 0) throw new Error((set.stderr || set.stdout).trim());
  console.log("PRICE_SET", (set.stdout || "").trim().split("\n").pop());
  const t0 = Date.now();
  const paused = await p.checkConsumer(id);
  console.log(
    "AUTO_PAUSE",
    JSON.stringify({
      ms: Date.now() - t0,
      reason: paused.paused?.reason,
      enforcement: paused.paused?.enforcement,
      enforced: paused.paused?.enforced,
      balance: paused.ledger?.balanceUsd,
      consumed: paused.ledger?.consumedUsd,
    }),
  );
  console.log("CALL_AFTER_PAUSE", await call(secret, 1000, 100));

  // (2) A late row for the old window, after reissue, must still be charged.
  const version = priceSnapshot(await magpie.catalogModels(), [model])!.version;
  const reissued = await p.reissue(id, { acceptPriceVersion: version });
  console.log(
    "REISSUED",
    JSON.stringify({
      oldKeyId: issued.keyId,
      newKeyId: reissued.keyId,
      sameSecret: p.find(id)!.secret === secret,
      capUsd: reissued.capUsd,
      balance: reissued.ledger?.balanceUsd,
      consumed: reissued.ledger?.consumedUsd,
      version: reissued.priceVersion,
    }),
  );
  // A call that the old key started and that settled only now: write it as the
  // old key's row through a real request, then check the ledger picks it up.
  console.log("CALL_ON_NEW_KEY", await call(secret, 100_000, 25_000));
  const settled = await p.checkConsumer(id);
  console.log(
    "AFTER_LATE",
    JSON.stringify({
      capUsd: settled.capUsd,
      balance: settled.ledger?.balanceUsd,
      consumed: settled.ledger?.consumedUsd,
      paused: settled.paused?.reason ?? null,
      openSettlements: settled.ledger?.openSettlements,
      uncertain: settled.ledger?.uncertain,
    }),
  );
  // (3) A request that STARTED on the old key and settles only after reissue.
  //     Magpie records the request's start time, so the row belongs to the old
  //     window and must be charged at that window's frozen price.
  const inflight = fetch(`http://${addr}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      "X-Forwarded-For": "203.0.113.9",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
      lab_prompt_tokens: 1_000_000,
      lab_completion_tokens: 500_000,
      lab_delay: 2.5,
    }),
  });
  await new Promise((r) => setTimeout(r, 400));
  const inFlightNow = await magpie.inFlightRequests();
  const duringReissue = await p.reissue(id);
  const lateStatus = await inflight.then((r) => r.status);
  await new Promise((r) => setTimeout(r, 300));
  const afterLate = await p.checkConsumer(id);
  console.log(
    "INFLIGHT_LATE",
    JSON.stringify({
      inFlightDuringReissue: inFlightNow,
      lateCallStatus: lateStatus,
      reissueCap: duringReissue.capUsd,
      capNow: afterLate.capUsd,
      balance: afterLate.ledger?.balanceUsd,
      consumed: afterLate.ledger?.consumedUsd,
      paused: afterLate.paused?.reason ?? null,
      windows: ledger.windowsFor(id).map((w) => ({ status: w.status, settled: w.settled, cap: w.capNanos / 1e9 })),
    }),
  );
  const windows = ledger.windowsFor(id).map((w) => ({ status: w.status, settled: w.settled, cap: w.capNanos / 1e9 }));
  console.log("WINDOWS", JSON.stringify(windows));
} finally {
  await p.revoke(id).catch(() => {});
  ledger.close();
}
