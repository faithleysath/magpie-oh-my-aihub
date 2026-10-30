# Phase-8 live journey — failed attempts and corrections

The final measured run is [`lab-report.json`](lab-report.json). This file keeps the earlier failures
so a passing report cannot hide a changed harness. The sanitized raw files are next to it; the
disposable `/tmp` roots were deleted.

## Attempt 1 — P plugin API timeout (harness isolation bug)

Evidence: [`lab-report-attempt1-plugin-api-timeout.json`](lab-report-attempt1-plugin-api-timeout.json),
[`transcript-attempt1.log`](transcript-attempt1.log).

Result: `FAIL P: fresh Magpie … timed out waiting for P plugin API` after about 49s. The C steps had
not run.

Cause: the harness started `magpie serve` with the **source** app bundle
(`~/Projects/lab/magpie-iso/Magpie.app`), not the per-node copy. Magpie portable mode resolves its
data folder beside `Magpie.app`; the source bundle therefore used the source lab profile
(`~/Projects/lab/magpie-iso/data`), while the plugin had been installed into the per-node data
directory. The host API never appeared where the harness looked.

Correction: every node now runs its own copied `Magpie.app` (`<lab>/<node>/Magpie.app`) and sets
`OH_MY_AIHUB_MAGPIE` to that copy. The source profile was not used again. Its `plugins.json` had
received two dead lab plugin specs during this failed attempt; it was restored to the prior
spike-only list. The user's installed Magpie profile (`~/.config/magpie`) was never read or written.

## Attempt 2 — C catalogue timeout (lab port-window bug)

Evidence: [`lab-report-attempt2-catalog-port-timeout.json`](lab-report-attempt2-catalog-port-timeout.json),
[`transcript-attempt2.log`](transcript-attempt2.log).

Result: `4 PASS, 1 FAIL`; P and C joined the overlay and P published, but
`C discovers P …` timed out. C saw the peer and tried the overlay, but the catalogue read timed out
after 5000 ms.

Cause: P's catalogue was configured on port **3542**, outside the consumer's bounded probe window.
Discovery probes the consumer's own configured catalogue port and the next four ports
(`cfg.catalog.port … +4`); the harness had used a random P port while C stayed on 3426. This is a
failure of the lab's single-machine port choice, not evidence about a real two-machine deployment
(where the default 3426 is normally free).

Correction: allocate one five-port window. C uses `<base>`, P uses `<base+1>`, P2 uses `<base+2>`,
and C is configured with `catalog config --port <base>`. No product scanning behaviour or
architecture changed.

## Attempt 3 — 18/18 pass, report metadata incomplete

Evidence: [`lab-report-run3-pass-before-manifest.json`](lab-report-run3-pass-before-manifest.json),
[`transcript-run3-pass-before-manifest.log`](transcript-run3-pass-before-manifest.log).

The journey passed all 18 steps, but the report did not yet capture the per-node source hashes or a
detailed port-free cleanup map. It is kept as a pass record, not the final evidence.

## Attempt 4 — wallet statement refused (product finding)

Evidence: [`lab-report-run6-statement-fail.json`](lab-report-run6-statement-fail.json),
[`transcript-run6-statement-fail.log`](transcript-run6-statement-fail.log),
[`source-manifest-run6.json`](source-manifest-run6.json), [`cleanup-run6.json`](cleanup-run6.json).

Result: `17 PASS, 1 FAIL`. The wallet typed data and both chains passed; the final step added a live
`wallet statement` and the host/CLI refused to produce it:

```text
error: statement verification failed: accounting has an unexpected field serving
```

Cause: `plugin/bin/ohmyaihub.ts` `statementFromEvidence` spreads the wallet evidence accounting
object (which includes `serving`) into the statement input, while
`plugin/src/walletstatement.ts` allows only `state`, `reason`, `openSettlements` under
`accounting`. The statement is therefore blocked on this tree; it is a product finding for the
CLI/wallet owner, not a reason to weaken the verifier or to claim a statement.

The final harness records the typed-data result and marks the statement `UNKNOWN` with this exact
error unless the owning agent patches it. No statement file was written by the blocked attempt.

## Attempt 5 — statement fixed in the product, but the harness read the file wrongly

Evidence: [`lab-report-run7-statement-unknown.json`](lab-report-run7-statement-unknown.json),
[`transcript-run7-statement-unknown.log`](transcript-run7-statement-unknown.log),
[`lab-report-run8-statement-parse-fail.json`](lab-report-run8-statement-parse-fail.json),
[`transcript-run8-statement-parse-fail.log`](transcript-run8-statement-parse-fail.log).

The owner fixed the `serving` projection; the statement command then wrote a valid file, but the
harness looked for a `{statement:{…}}` wrapper. The file is deliberately the **bare** statement body
(no wrapper), so the harness failed with `undefined is not an object (evaluating 'body.consumerId')`.
Correction: read `doc.statement ?? doc`, the same rule `verifyStatement` uses. No product change.

## Attempt 6 — C `magpie plugin add` exit code

Evidence: `/tmp/phase8-journey-run9.log` (short run, lab removed; not copied because it contains no
new product signal). `magpie plugin add` returned non-zero after the host it starts logged a startup
error, although `plugins.json` recorded the spec. The harness now accepts that exit code **only** when
`plugins.json` lists exactly the per-node plugin path; any other failure still aborts.

## Attempt 7 — source manifest race (tree edited during the run)

Evidence: [`source-manifest-run7.json`](source-manifest-run7.json) (`ok:false`, no hashes) and the
run10 report. The functional steps passed 18/18, but the manifest compared the per-node copies with a
tree another agent was editing, so it could not prove the tested code. Correction: the harness now
captures every manifest hash at copy time, re-hashes before cleanup, and fails with the differing
file names if anything moved.

## What counts as a PASS — and what does not

A run is accepted only when **all three** of these hold in the same run:

1. every functional step reports `ok:true` (the report's `summary.failed` is `0`),
2. `wallet.statement.ok` is `true`,
3. `source-manifest.json` has `ok:true` with non-null hashes that match the repo.

Only the latest [`lab-report.json`](lab-report.json) + [`source-manifest.json`](source-manifest.json) +
[`wallet-statement.json`](wallet-statement.json) satisfy all three. The earlier files are kept exactly
as they were produced — their `summary` is not rewritten — but they are **not** acceptance evidence:

| File | `summary` | Statement | Manifest | Verdict |
| --- | --- | --- | --- | --- |
| `lab-report-run3-pass-before-manifest.json` | 18 / 0 | not attempted | absent | **history only** — no manifest, so it cannot prove which code was tested |
| `lab-report-run7-statement-unknown.json` | 18 / 1 | `ok:false` (statement refused) | `source-manifest-run7.json` `ok:false` | **rejected** — statement failed and the tested code was unproven |
| `lab-report-run8-statement-parse-fail.json` | 18 / 0 | `ok:false` (harness read the bare body as a wrapper) | not written | **rejected** — a `18/0` summary here is a harness bug, not a product pass |

In particular, `run8`'s `summary` of 18 passed / 0 failed must **not** be read as an acceptance PASS:
its `wallet.statement.ok` is `false`, so the wallet step did not complete, and no manifest was
captured. The same applies to `run7`'s manifest. A clean `summary` alone has never been the criterion.

## Final run (frozen tree)

See [`lab-report.json`](lab-report.json), [`transcript.log`](transcript.log),
[`source-manifest.json`](source-manifest.json), [`wallet-statement.json`](wallet-statement.json) and
[`cleanup.json`](cleanup.json).

- 18/18 steps pass; the wallet statement produced a 0600 file with digest
  `1e72d3f3278d474bee4e0e5999d8c56c43e31559db69808eaab11ad478cc5f9a`, both chains, two cancelled
  requests, no signature and no transfer.
- The source manifest is `ok:true`: all 13 files are non-null, identical across the three node copies,
  unchanged since the copy, and byte-identical to the repo source at report time.
- Cleanup: 6 owned PIDs stopped, 0 remaining, all 13 allocated ports free, lab root removed.
