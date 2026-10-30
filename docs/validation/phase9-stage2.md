# Phase 9 — sharing/connection browser acceptance

**REPRODUCED** on macOS 26.6.2 arm64, real Magpie 0.1.2171, Magpie-managed Bun1.4.4,
EasyTier2.6.4, local deterministic upstream. Stage1 source/session details are in
[the entry report](phase9-stage1.md). This record covers graphical sharing, discovery, approval,
private handover, native Remote Magpie registration and a model request; wallet recovery follows
in the final Phase9 report.

## Actual installation and update

The consumer started as an isolated profile without the plugin. In real Magpie's Plugins →
Discover, the actor cleared search, filled the ordinary installer with
`github:faithleysath/magpie-oh-my-aihub#feature/local-web-console` and clicked Install.
The installed card reported `c915727` and “Plugins run on Bun1.4.4”. No independent Bun was on
that fixture's PATH. The actor then used Installed → Check for updates → Update to obtain
`8b86115`, and later `03d9981`; [screenshot](phase9-browser/github-install-update.png).
Normal release instructions omit the development branch after merge.

The provider's initial local package installation is a maintainer fixture; the consumer and second
provider GitHub installations prove the ordinary nonterminal distribution path. Neither actor
needed the plugin source/data directory, an operator command, a manual API call or a JSON edit.

## Chromium journey through the actual UI

The following operations were clicks, form inputs and private file exchange in ego Chromium156:

1. Provider chose its priced native `provider/provider-model`, saved the whitelist and published
   its signed catalogue as “星河工作室 · 测试共享”. Input/output prices1000/1000 and cache prices0/0
   are deliberately high fixture rates for a short budget test. `priceLocked:false` stays visible.
2. Fresh consumer used the welcome form to enable consuming, join the same private network via
   the provider's EasyTier listener, and enable catalogue discovery. The first immediate scan
   observed the SOCKS listener still starting; a normal Refresh directory then found the provider.
   A transient offline result was not reported as successful gateway authentication.
3. Consumer reviewed the complete64hex identity fingerprint. The provider independently showed
   the same fingerprint through its catalogue identity evidence; My Sharing now has a dedicated
   public identity panel. The actor explicitly checked the trust box and accepted the identity.
4. Consumer selected the native model, accepted the current unlocked quote and generated/downloaded
   a connection-request file. Provider imported that file, inspected the current quote, selected
   the model, typed positive cap `$0.0001`, checked the manual approval and approved.
5. Provider explicitly requested private key handover, confirmed it, downloaded the authorization
   file and clicked “完成并隐藏”. DOM observation confirmed that secret inputs were removed.
   No snapshot or screenshot was taken while key contents were visible. The private files stayed
   in the disposable lab directory; browser download permissions are not claimed to be0600.
6. Consumer imported the authorization file, accepted its preview and confirmed connection.
   Production Service registered native Remote Magpie `peer-f4754eac`, loopback forward13425 to
   provider mapped address10.66.99.148/32, and read back cap `$0.0001`. “读取可用模型” returned the
   actual authorized `provider/provider-model`.
7. In consumer Magpie's **own** Providers → Remote magpie editor, “Test models” first answered
   successfully. A second click returned the provider's **native429**. The plugin does not
   forward or meter either AI request. [Sanitized UI result](phase9-browser/native-model-200-429.json)
   retains the model chip's actual titles. This native provider test goes to the configured remote
   endpoint; it is not a separate claim of a fresh external-client request through the consumer's
   public gateway.

The provider's consumer row and consumer connection subsequently reported used `$0.0120`, cap
`$0.0001` and no remaining credit. This preserves the already-known native soft-ceiling overshoot;
it is not a new hard prepaid guarantee.

## WebKit and multiple providers

**REPRODUCED** using WebKit27.2/Playwright1.64.1 and production code. A third isolated profile
installed the GitHub plugin through Magpie, paired its browser, configured its real EasyTier node,
selected its native model and published “林间实验室 · 第二提供者”. The existing consumer compared
its full fingerprint with that provider's own rendered identity, explicitly trusted it and exported
a request. The second provider imported, manually approved a positive `$1` cap and exported the
private authorization. Consumer previewed/imported it and retained **two native Remote Magpie
connections** simultaneously.

- [Five-step WebKit result](phase9-browser/webkit-sharing.json)
- [Two-provider screenshot](phase9-browser/webkit-two-providers.png)
- [Retained first harness failure](phase9-browser/webkit-sharing-failure.json): it looked for
  `data-model-id` on the sharing picker, which used a checkbox without that attribute. The harness
  was corrected to use the observed picker. Existing configured state was resumed through the UI;
  no domain data was reset or injected.

Maintainer reproduction:

```sh
python3 docs/validation/lab/phase9/harness.py start --runtime /tmp/<lab>/runtime.json --node provider2
cd plugin
bun scripts/console-webkit-sharing.ts /tmp/<lab>/runtime.json ../docs/validation/phase9-browser
```

## Integration defects and review fixes

**REPRODUCED / fixed:** a queued native `dialog.close` event from the previous step closed a newly
opened download/preview window. The close handler now cleans up only when the dialog is still
closed. The regression dispatches close asynchronously, fails on the old implementation and
passes after repair; the actual request and authorization file exchanges were repeated successfully.

**REPRODUCED / fixed in03d9981:** an existing manual Remote connection could mark a first-seen
catalogue `connected` despite no persisted TOFU acceptance. Authorization now checks the persisted
accepted fingerprint independently of connectivity and preserves changed/stale identity warnings
through refresh failure.

**REPRODUCED / fixed in03d9981:** an authorization document could name model A while its Key
returned A+B. File-based connection now compares the actual remote model set with the reviewed
file before native registration, and rechecks identity/quote after asynchronous reads. Regression
coverage includes extra/missing/duplicate models and preservation of unrelated owned/foreign
providers. The successful live one-model file path was measured before this stricter regression
fix and remains scheduled for final-tree regression acceptance.

**VERIFIED tests/UI semantics:** zero/negative cap displays “无限制 / 不安全配置”; absent cap remains
unknown, never a green inference from connectivity. A narrowed whitelist pauses safely when its
price binding changes; explicit current-price reissue retains ledger balance. Sensitive key-reveal
UUIDs retain only replay tombstones, not cached secret responses.

## Limits at this checkpoint

The original first-provider journey is Chromium; the second-provider journey is WebKit. Both use
actual Magpie, EasyTier, Service and browser sessions. The mock model avoids vendor charges. No
public-chain transaction was made here. Wallet finality/credit/resumed model success, targeted
provider outage, final-tree CI and environment cleanup must be recorded in the final report.
Existing public BSC/Base payment evidence remains PR11's separate measured scope.

Real-money Production remains **NO-GO**.
