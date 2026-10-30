// Phase-6 real-Magpie price-change check. LAB ONLY.
//
// Expects the isolated instance to price labmock/lab-model at 1,2,0.1,0.2.
// It changes that price through Magpie's own CLI, then verifies that the
// plugin pauses, refuses a reissue without explicit acceptance, and carries
// only the old-price consumption into the new key.
//
//   MAGPIE_DATA=... MAGPIE_BIN=... MAGPIE_ADDR=127.0.0.1:3446 \
//   bun docs/validation/lab/phase6/real-price-change.ts pricelab

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
process.env.MAGPIE_ADDR ??= "127.0.0.1:3446";
const id = process.argv[2] ?? "pricelab";
const model = process.env.LAB_MODEL ?? "labmock/lab-model";

const magpie = new Magpie(bin);
const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "phase6-price-")), "ledger.sqlite"));
const p = new Provisioner(magpie, {
  ledger,
  prices: async (models) => priceSnapshot(await magpie.catalogModels(), models),
  usageLog: () => join(data, "usage.jsonl"),
  drainMs: 800,
});

try {
  const issued = await p.ensure(id, { models: [model], capUsd: 1 });
  const secret = p.find(id)!.secret;
  const call = await fetch(`http://${process.env.MAGPIE_ADDR}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
      lab_prompt_tokens: 200_000,
      lab_completion_tokens: 50_000,
    }),
  });
  console.log("CALL", call.status);
  const before = await p.status(id);
  console.log("BEFORE", JSON.stringify({ used: before.usedUsd, balance: before.ledger?.balanceUsd, version: before.priceVersion }));

  const set = spawnSync(bin, ["model", "price", model, "2,4,0.2,0.4"], { encoding: "utf8" });
  if (set.status !== 0) throw new Error((set.stderr || set.stdout).trim());
  console.log("PRICE_SET", (set.stdout || "").trim().split("\n").pop());

  const paused = await p.status(id);
  console.log("PAUSED", JSON.stringify({ reason: paused.paused?.reason, enforced: paused.paused?.enforced, balance: paused.ledger?.balanceUsd, consumed: paused.ledger?.consumedUsd }));
  await p.reissue(id).then(
    () => {
      throw new Error("reissue without acceptPriceVersion unexpectedly succeeded");
    },
    (e: Error) => console.log("REFUSED", e.message.slice(0, 120)),
  );
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
} finally {
  await p.revoke(id).catch(() => {});
  ledger.close();
}
