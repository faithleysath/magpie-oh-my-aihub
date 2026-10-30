# Phase-6 pricing and window lab

This lab is deliberately **local and non-billable**. A portable Magpie 0.1.2038 talks to a
deterministic mock upstream; no vendor key, wallet, chain or real money is used.

## Layout

```
~/Projects/lab/magpie-pricing-2038/
  Magpie.app/                 portable copy of Magpie 0.1.2038
  data/                       its own Magpie data dir (portable mode)
  mock_upstream.py            this directory's script
  serve.log
```

The isolated gateway uses `127.0.0.1:3446`; the mock upstream uses `127.0.0.1:19080`. Never point
this lab at the real `~/.config/magpie`, and never use a real Gateway Key or provider key.

## Start

```sh
LAB=~/Projects/lab/magpie-pricing-2038
mkdir -p "$LAB/data"
cp -R /Applications/magpie.app "$LAB/Magpie.app"
cp docs/validation/lab/phase6/mock_upstream.py "$LAB/"
python3 "$LAB/mock_upstream.py" 19080 &

cd "$LAB"
export MAGPIE_NO_ACCOUNTS=1 HOME="$LAB/home"
BIN="$LAB/Magpie.app/Contents/MacOS/magpie"
$BIN provider add labmock url=http://127.0.0.1:19080/v1 key=sk-lab models=lab-model id=labmock
$BIN model price labmock/lab-model 1,2,0.1,0.2
MAGPIE_ADDR=127.0.0.1:3446 $BIN serve
```

Create a key and a 3650-day cost cap (the value is printed by `gateway-key add`; keep it local):

```sh
$BIN gateway-key add labkey
$BIN gateway-key list                       # read the id
$BIN gateway-key models <id> labmock/lab-model
$BIN gateway-key limit <id> 3650d --cost 10
```

Set `KEY` to the printed secret. A call that costs $0.0012 at 1/2 per 1M:

```sh
curl -sS -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"labmock/lab-model","messages":[{"role":"user","content":"hi"}],
       "lab_prompt_tokens":1000,"lab_completion_tokens":100}' \
  http://127.0.0.1:3446/v1/chat/completions
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:3446/v1/magpie/limit
```

## Price change, without and with restart

```sh
$BIN model price labmock/lab-model 10,20,1,2
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:3446/v1/magpie/limit
# /v1/magpie/limit reprices the old call immediately: cost 0.012
# a new call may still be admitted from the process's older in-memory sum
# restart `serve` and the admission sum is rebuilt at the new price
```

## Window boundary (explicit state injection)

The lab cannot wait 3650 days. Copy `data/caller-keys.json` first, then move the key's `since` back
by one cycle plus a few seconds. This is a **state injection**, not natural passage of time, and is
labelled as such in the report.

```sh
cp data/caller-keys.json data/caller-keys.before-injection.json
python3 - <<'PY'
import json, datetime
p = "data/caller-keys.json"
keys = json.load(open(p))
for k in keys:
    if k["name"] == "labkey":
        k["limit"]["since"] = (
            datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=3650, seconds=5)
        ).astimezone().isoformat()
open(p, "w").write(json.dumps(keys, indent=2) + "\n")
PY
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:3446/v1/magpie/limit
```

The native window starts a few seconds ago, `calls` is 0 and `costLeft` is the full cap again even
though the usage log still contains the old calls. That is the re-grant the ledger fixes.

For the in-flight test, create a key with a one-hour limit whose `since` is one hour ago minus six
seconds, then send a call with `"lab_delay":8` and a `$8` token count. It completes after the
boundary and the new window still reports `calls:0`.

Restore `caller-keys.json` from the backup when finished. Do not run these edits against a real
Magpie data directory.

## What is not tested here

- a second physical machine (the overlay path is covered by the phase-3/4/5 labs);
- a real vendor bill (the lab's prices and usage are synthetic);
- a real clock crossing a day/week/month boundary (the `since` injection exercises the same
  `Limit.Window` arithmetic, but is not a wall-clock observation);
- Magpie on Windows/Linux (this lab is macOS arm64 only).
