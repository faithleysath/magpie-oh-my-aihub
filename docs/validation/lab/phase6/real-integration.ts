// Phase-6 real-Magpie integration check. LAB ONLY.
//
// It drives the plugin's Provisioner/Ledger against a portable Magpie 0.1.2038
// data directory and a deterministic local mock upstream. It deliberately
// injects a window boundary by editing that *isolated* caller-keys.json; never
// point it at a real Magpie data directory.
//
//   MAGPIE_DATA=~/Projects/lab/magpie-pricing-2038/data \
//   MAGPIE_BIN=~/Projects/lab/magpie-pricing-2038/Magpie.app/Contents/MacOS/magpie \
//   MAGPIE_ADDR=127.0.0.1:3446 \
//   bun docs/validation/lab/phase6/real-integration.ts ledgerlab
//
// The Gateway Key secret is never printed. The consumer is revoked at the end.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const id = process.argv[2] ?? "ledgerlab";
const model = process.env.LAB_MODEL ?? "labmock/lab-model";

const magpie = new Magpie(bin);
const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "phase6-real-")), "ledger.sqlite"));
const p = new Provisioner(magpie, {
  ledger,
  prices: async (models) => priceSnapshot(await magpie.catalogModels(), models),
  usageLog: () => join(data, "usage.jsonl"),
  drainMs: 800,
});

try {
  const issued = await p.ensure(id, { models: [model], capUsd: 1 });
  const secret = p.find(id)!.secret;
  console.log(
    "ISSUED",
    JSON.stringify({ keyId: issued.keyId, capUsd: issued.capUsd, window: issued.window, priceVersion: issued.priceVersion, balance: issued.ledger?.balanceUsd }),
  );

  const call = await fetch(`http://${process.env.MAGPIE_ADDR}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
      lab_prompt_tokens: 600_000,
      lab_completion_tokens: 100_000,
    }),
  });
  console.log("CALL", call.status);

  const status = await p.status(id);
  console.log(
    "STATUS",
    JSON.stringify({ used: status.usedUsd, cap: status.capUsd, balance: status.ledger?.balanceUsd, consumed: status.ledger?.consumedUsd }),
  );

  const after = await p.topUp(id, 0.1, `real-${Date.now()}`);
  console.log("TOPUP", JSON.stringify({ used: after.usedUsd, cap: after.capUsd, credited: after.creditedUsd, balance: after.ledger?.balanceUsd }));

  // Injected boundary: move the isolated native key's cycle anchor back by one
  // 3650-day cycle plus five seconds. This is a state injection, not a clock.
  const keysFile = join(data, "caller-keys.json");
  const keys = JSON.parse(readFileSync(keysFile, "utf8")) as {
    name: string;
    limit: { since: string };
  }[];
  const key = keys.find((k) => k.name === `ohmyaihub-${id}`);
  if (!key) throw new Error("the lab key is not in caller-keys.json");
  const before = key.limit.since;
  key.limit.since = new Date(Date.now() - 3650 * 86_400_000 - 5_000).toISOString();
  writeFileSync(keysFile, JSON.stringify(keys, null, 2) + "\n");
  console.log("INJECTED_SINCE", before, "->", key.limit.since);

  const rolled = await p.status(id);
  console.log(
    "AFTER_BOUNDARY",
    JSON.stringify({ paused: rolled.paused?.reason, enforced: rolled.paused?.enforced, balance: rolled.ledger?.balanceUsd }),
  );
  const reissued = await p.reissue(id);
  console.log(
    "REISSUED",
    JSON.stringify({
      oldKeyId: issued.keyId,
      newKeyId: reissued.keyId,
      sameSecret: p.find(id)!.secret === secret,
      capUsd: reissued.capUsd,
      balance: reissued.ledger?.balanceUsd,
    }),
  );
} finally {
  await p.revoke(id).catch(() => {});
  ledger.close();
}
