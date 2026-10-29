# 2026-10-30 — PR #4 review fixes

The review of PR #4 found real defects. This note records each one: how it was reproduced,
the root cause, what changed, and how it was verified. Everything runs with **Bun 1.4.3** and
**TypeScript 5.9** (`bunx tsc --noEmit`) on **macOS 26.6.2 arm64**; the Linux path was exercised
by the unit tests here and runs in the Linux CI job.

Result summary: **2 P0 defects confirmed** (the version name clash was a live crash, not a
warning), **1 P0 validator weakness confirmed**, **3 P1 gaps confirmed**, one behaviour the
review listed as missing that was already present (now enforced by tests anyway). Type check
clean, **75 tests pass** (was 26 at review time, 58 after the first patch), the entry boots, the
credential scan passes, and the real two-instance regression still passes end to end.

A second acceptance patch (§11) adds the Linux CI fix, the top-up race fix and the runtime
fail-closed path with fault injection.

---

## 1. P0 — `Magpie` had a field and a method named `version`

**Confirmed. It broke the plugin entry at runtime.**

`plugin/src/magpie.ts` declared `private version: string | null = null` and `version(): string`.
In JavaScript a class field is an own property and shadows the prototype method:

```
$ bun /tmp/repro/version-conflict.ts
typeof m.version: object
THROWS: m.version is not a function. (In 'm.version()', 'm.version' is null)
```

TypeScript agrees (TS2300 twice, with 5.9 and 7.0.2):

```
version-conflict.ts(2,11): error TS2300: Duplicate identifier 'version'.
version-conflict.ts(3,3):  error TS2300: Duplicate identifier 'version'.
```

The real entry failed the same way, and because the default export catches boot errors the
host stayed up with no API and no supervisor:

```
[oh-my-aihub] ERROR plugin failed to start: TypeError: magpie.version is not a function.
              (In 'magpie.version()', 'magpie.version' is null)
```

**Why the install tests did not catch it.** The successful phase-3 lab ran before the refactor:
at that point `version()` was an async method and there was no field. The field was introduced
later, while removing the `magpie --version` call that had saturated the CPU. The entry's
`boot()` is started by the default export with `.catch(logger.error)` (so Magpie cannot crash on
a plugin), and the last verification after that edit never re-read the boot log. Both facts are
why "bun test passed" was not enough — `bun test` never imported the entry.

**Fix.** The field is now `versionLabel`; `version()` and `detectVersion()` are unchanged in
behaviour. New tests (`test/magpie.test.ts`) assert that `magpie.version` is a function, that
`version()` is stable and spawns no process, that `detectVersion()` spawns once, caches, and
keeps a label when the binary does not answer. `scripts/boot-check.ts` now starts the real entry
on every CI run.

Also checked: no other class has a field that shadows a method (`grep` over `src/*.ts` shows
only `Magpie.version`, now renamed).

---

## 2. P0 — Linux read `/proc/<pid>/exe` as a file

**Confirmed.** `paths.ts` used `readFileSync("/proc/<ppid>/exe")`. On Linux that path is a
symlink to the executable; reading it returns the **executable's bytes** (tens of MB) and the
code then used those bytes as a path.

**Fix.** `readlinkSync`, with the kernel's `" (deleted)"` suffix stripped, and a strict
resolver:

- a parent that is clearly a `magpie` but cannot be resolved is an **error**, never a silent
  fallback to another installation;
- `OH_MY_AIHUB_MAGPIE` set to a missing file is an error (no fallback);
- a parent that is not a magpie (a test runner, a shell) may fall through to the app bundle or
  `PATH`;
- the parent's `argv[0]` may be relative (`./Magpie.app/…`), so it is resolved against the
  parent's own working directory (`lsof -d cwd`), which is what a portable copy needs.

Tests (`test/paths.test.ts`): the symlink is read as a path (spaces and `(deleted)` included),
a missing `/proc` entry falls through, the override and the unresolved-parent cases throw, the
relative parent path resolves, and — on a Linux runner — `/proc/self/exe` is a short path with
no NUL bytes. The default resolver on this Mac returns the real binary.

---

## 3. P0 — ACL validation was string matching, not a proof

**Confirmed, and stricter checking immediately found a second bug.**

Before: `checkAclInvariants()` searched the text for a few substrings. It could not see an extra
allowed port, a second Inbound chain with a hidden rule, a disabled Inbound chain (whose default
action is then taken from the first *enabled* one, or from EasyTier's `Allow`), a wrong
`chain_type`, `forward_by_system`, or an export that differs from the one the plugin wrote.

Now `src/acl.ts` parses the configuration with **`Bun.TOML.parse`** (fail closed when no parser
is available) and checks:

- `flags.no_tun === true`, no `forward_by_system`, no `disable_encryption`, no
  `tcp_whitelist`/`udp_whitelist`;
- `network_identity.network_name` equals the configured network;
- Secure Mode on **with a pinned keypair** when the plugin asked for it;
- providers: exactly one `proxy_network` entry, with the expected real and mapped prefixes
  (compared as prefixes, so EasyTier's `/32` → bare-address normalization does not fail);
  consumers: no export at all;
- every Inbound chain (enabled or not) has `default_action = Drop` and **zero rules**, and at
  least one Inbound chain is enabled;
- every enabled Forward chain defaults to Drop, and the **set of allowed TCP ports equals
  exactly** the published ports — no ranges, no address-scoped rules, no non-TCP, nothing extra;
- a consumer may forward nothing;
- unknown chain types and unparsable documents are failures.

The same check runs on the generated file **before** starting and on the **running** core's
config (`easytier-cli node -o json` → `config`) after starting. A failure there **stops the
core** (fail closed) instead of showing a warning.

**The bug the strictness found:** EasyTier reports `cidr = "192.0.2.84"` for a `/32` export, so
the first strict version refused the running config and stopped the core — `core-running:
refusing to serve: proxy_network cidr is 192.0.2.84, expected 192.0.2.84/32`. That is fail-closed
behaviour working as intended and a comparison bug at the same time; prefixes are now compared
after normalization, and a test pins that case.

Tests (`test/acl.test.ts`, 20 cases): the generated provider/consumer configs pass; every
malicious mutation above is refused, including a hidden allow in a disabled second Inbound
chain, an extra forwarded port, a port range, an address-scoped allow, a second export, and a
wrong network name.

---

## 4. P1 — `relocateProxy()` was never called

**Confirmed.** The function existed but nothing invoked it; the monitor only refreshed peers.

Now the 10-second monitor calls `maybeRelocate()`, which uses an exported pure decision
(`relocationDecision`): the new address must be seen **twice**, and the previous move must be at
least **60 s** old, so a flapping interface cannot restart the core in a loop. On a move the
export is rewritten, the core is restarted (2.6.4 has no runtime edit), the ACL is re-checked by
the normal start path, and the plugin's persisted configuration is updated through
`onProxyMoved`.

Tests: `test/process.test.ts` covers no-change, one sighting, two sightings, a flap back, the
one-minute guard, and missing inputs. **UNKNOWN:** a real interface change on a multi-NIC host
and a physical disconnect (no such environment here); the decision logic and the restart path
are tested, the OS event is not.

---

## 5. P1 — binary integrity and process identity

**Confirmed.** The supervisor trusted a `.sha256` marker next to the extracted binaries: it said
which archive was unpacked once, not what the files are now.

Now the installer records the **SHA-256 of each installed binary** (`.binaries.json`) and every
start hashes `easytier-core` and `easytier-cli` again; a mismatch (or a missing record) deletes
the directory and reinstalls from the pinned archive, whose own hash is still verified first. The
cost is two file reads (~21 MB + 9 MB) at start, tens of milliseconds.

Process identity: `adoptable(pid)` used to accept any live process whose command contained
`easytier-core`. It now requires the command line to contain **our own config path**
(`ownsProcess`), so a recycled pid or another EasyTier on the machine is never adopted, and the
supervisor never signals a process it does not own.

Tests: the binary download is refused on a hash mismatch (stubbed `fetch`), an unlisted platform
is refused before any download; `ownsProcess` rejects this test runner's pid, pid 1, 0, negative
and unlikely pids. The real lab re-ran the full crash/restart and disable/enable paths
(§8).

---

## 6. P1 — key and connection consistency

All seven items were real except one that was already correct:

| Review item | Before | Now |
| --- | --- | --- |
| concurrent top-ups lose an update | no lock | one operation per consumer (promise chain); two parallel deposits both apply (test) |
| Magpie updated, local write failed | cap committed before verification | the new cap is written to a `pending` record **before** Magpie, verified, then committed; `reconcile()` on load/status finishes a cap Magpie really holds and drops one it does not |
| repeated simulated deposit | applied twice | `depositId` recorded in `deposits[]`; a replay returns the current state (test) |
| partial key left behind | key stayed usable | any failure after `gateway-key add` deletes the key and the local record (test) |
| failed `connect` breaks the old provider | old provider removed first | the new forward and provider are added beside the old one, the ingress and the model list are verified, and only then is the old one dropped; on any failure the new pieces are rolled back and the old wiring kept (including the same-id replacement case) |
| handing over before configuration is proven | returned the local record | `handover` runs the full read-back first and fails otherwise |
| cap validation | `>= 0.0001` only | finite, `<= $1,000,000`, exactly on the $0.0001 grid, and top-ups too |

`reconcile()` is covered by two tests: a matching cap commits the pending deposit, a different
cap drops the intent without crediting. The real lab replay of deposit `dep-regression` kept the
cap at 1.0005 and the credit at 1.

---

## 7. Automated quality gates

- `plugin/tsconfig.json` (strict, `noEmit`, Bun types) and `bun.lock` committed.
- `.github/workflows/plugin.yml`: on pull requests touching `plugin/`, on Linux **and** macOS —
  `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`, `bun run boot-check`,
  `bun run secret-scan`.
- `scripts/boot-check.ts` starts the **real entry** with a stub `magpie` binary, an isolated
  `HOME` and data directory, and asserts: the API answers, `/status` and `/checks` work, the
  token file is mode 0600, an unauthenticated mutation is 401, and the home directory was not
  written to.
- `scripts/secret-scan.ts` refuses gateway keys, private keys, bearer tokens and real network
  secrets; the archived `prototype/` is excluded (its made-up keys belong to the abandoned
  sidecar, never to Magpie).

Local run:

```
$ bun run typecheck && echo ok      # ok
$ bun test                          # 58 pass, 0 fail
$ bun run boot-check                # boot-check PASS: plugin 0.1.0, magpie 0.1.2038, api 34517
$ bun run secret-scan               # secret-scan PASS
```

---

## 8. Real regression after the fixes (macOS, two isolated Magpie 0.1.2038)

Each instance ran with its **own `HOME`** this time, so Magpie's agent-catalog sync cannot touch
the user's agent configuration (the phase-3 incident). The user's `~/.pi/agent/models.json` kept
its mtime and still points at `127.0.0.1:3425`; the user's Magpie has only its own key.

| Step | Result |
| --- | --- |
| install into both instances (`magpie plugin add <path>`) | plugin listed with its page |
| boot | both hosts start, APIs on 34517 / 34518, correct binary in both |
| configure provider / consumer | EasyTier 2.6.4 downloaded, hash verified, mapped prefix `10.66.16.222/32`, peers p2p |
| provider checks | **PASS** core, ACL, 401 without a key, mapped prefix |
| consumer checks | **PASS** core, ACL, ingress 401 after connect |
| virtual IP `:3441`, no key / valid key | `000` / `000` (dropped) |
| key | model whitelist, cap `$0.0005`, read-back, `pending: false` |
| connect | provider registered, `provider-a/…` listed, ingress verified |
| 5 calls | used `0.000575` on a `0.0005` cap → spent (soft ceiling) |
| next call | **429** |
| deposit `$1` (`dep-regression`) | cap `1.0005`, used kept, replay did not double-credit |
| next call, no consumer change | **200**, used `0.000706` |
| revoke | next call **401** |

---

## 9. Confirmed vs not

- Confirmed: the version clash (a live crash), the `/proc` read, the ACL validator's gaps, the
  uncalled relocation, marker-only binary trust, and all seven key/connection items (the
  "cap validation" item was weaker than described but still needed the grid/bounds check).
- Not a defect: the review's "a missing Forward chain" case was already generated correctly;
  what was missing was the **check**. It now fails closed.
- One behaviour worth knowing: the CLI's key name, `ohmyaihub-<consumerId>`, is unchanged; no
  duplicate or renamed keys were found on the user's instance.

## 10. Merge recommendation

**Merge PR #4 after these commits.** The two P0 defects are fixed and now covered by a test that
starts the real entry, the ACL check is a real proof rather than a substring search, and the
on-disk key/connection operations are idempotent and recoverable. Remaining UNKNOWNs are the
same product limits already listed (Windows/Linux Magpie end to end, the page in a browser,
multi-NIC relocation, several providers per consumer), plus the pricing lock that blocks real
credit.

---

## 11. Final acceptance patch: CI, top-up races, runtime fail closed

### 11.1 Linux CI — the parent process was taken for Magpie

**Root cause.** On Linux, `resolveMagpieBin()` returned `/proc/<ppid>/exe` whenever the target
**existed**, without asking whether it was Magpie. Under `bun test` on the CI runner the parent is
`bash`, so it returned `/usr/bin/bash`; the "finds a Magpie on this host" test then demanded a path
containing `magpie` and failed (58 pass / 1 fail).

**Fix.** Only a program whose basename is `magpie` (`magpie`, `magpie.exe`) may be taken from
`/proc`; anything else falls through to the parent's argv, then the macOS bundle, then `PATH`. A
parent that **is** Magpie but cannot be resolved stays a hard error, so no other installation is
silently used. Tests: a simulated bash parent resolves through `PATH`; a simulated Magpie parent is
used as-is; a Magpie parent that vanished (`/old/magpie (deleted)`) throws even though `PATH` has
another one. The "real host" test is skipped only when the resolver reports that this machine has
no Magpie at all — never to hide a failure.

### 11.2 The top-up race with real traffic

**Root cause.** `topUp()` compared the key's used cost before and after the cap write and treated
any difference as an error, then cleared the pending intent and threw. A consumer calling models
during a deposit (or a window rolling over) changes that number legitimately, so a correct deposit
was reported as failed and could be retried.

**Fix.** The cap is the only invariant of a deposit: the read-back must show the cap that was
written; usage is recorded (`usage moved 0.4 -> 0.43 while the cap was raised (allowed)`) and never
compared for equality. In addition:

- a `depositId` is bound to its amount — replaying it with another amount is refused, replaying it
  with the same amount returns the current state and credits once;
- `refreshAll()` now takes the same per-consumer lock as `topUp()`/`status()`, so a background
  refresh cannot read or rewrite the ledger mid-deposit;
- the pending intent is written before Magpie and survives a local write failure; a restart
  reconciles it from what the gateway holds (credit if the cap is there, drop it if not);
- a Magpie write that failed is never credited;
- the plugin never calls `limit reset` (a source-level regression test asserts it).

Tests (`test/provisioner.test.ts`): the reviewed scenario exactly (cap $1, used $0.40, deposit $1,
used becomes $0.43 during the write, read-back shows cap $2 / used $0.43 → deposit confirmed,
`pending:false`), replay of the same id, same id with a different amount, save failure after the
Magpie write followed by a restart/reconcile, a failed Magpie write followed by reconcile, and
`topUp` + `status` + `refreshAll` running together.

### 11.3 Runtime fail closed

**Root cause.** `refresh()` only stopped the core on an ACL structure failure. An export that was
not announced, an RPC portal on another address, a portal that could not be verified, and a
configuration that could not be read all merely set `aclOk = false` while the core kept serving.

**Fix.** Those checks now feed one verdict. Two consecutive failed checks stop the core this plugin
owns; the stop sets `stopping`, so the supervised restart does not bring it back. An explicit
`start()` (or a configuration change) re-validates the generated file and the running core before
serving again. `stop()` signals a child **by handle** when this process spawned it (a shell script's argv is not
the command line it was given), and an **adopted** pid only when its command line still runs our
config; the handle is cleared when the child exits, so a recycled pid is never signalled. A foreign
pid is never touched (tested).

Tests (`test/runtime.test.ts`, a fake `easytier-core` that sleeps and a fake `easytier-cli` that
answers from a file):

| Injected fault | Assertion |
| --- | --- |
| running config with `Inbound default_action = 1` | the pid is **gone** after the second check |
| RPC reported on `0.0.0.0` | stopped |
| RPC listener unverifiable (empty) | stopped |
| running config unreadable (RPC throws) | stopped after the retry |
| export missing from the running config | stopped |
| healthy core | stays running, `aclOk: true` |
| after an unsafe stop | no supervised restart; a new `start()` with a good config serves again |
| a foreign pid placed in the state | never signalled |

### 11.4 Re-run on macOS after this patch

Two isolated Magpie 0.1.2038 instances (each with its own `HOME`): install and boot, provider and
consumer checks **PASS**, virtual IP `000/000`, five calls to the `$0.0005` cap → `spent`, sixth
**429**, deposit `dep-final` (+$1) → cap `1.0005` with used `0.00054675` kept, the same event
replayed → still `credited 1`, next call **200**, revoke → **401**. No lab process, file or key was
left behind; the user's agent configuration and Magpie keys were not touched.

### 11.5 Status

`tsc` clean · **75 tests pass** · boot-check PASS · secret-scan PASS · Linux **and** macOS CI green
([run 40893223749](https://github.com/faithleysath/magpie-oh-my-aihub/actions/runs/40893223749)).
No P0 blocks remain. **Merge PR #4 after this commit.**
