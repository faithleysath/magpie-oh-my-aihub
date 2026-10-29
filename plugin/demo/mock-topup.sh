#!/bin/bash
# Mock top-up demo: no blockchain, no real money.
#
# Preconditions: two Magpie instances (or two computers) with this plugin
# installed and configured, the consumer's overlay connected to the provider, and
# the provider's Magpie serving at least one model. See the phase-3 validation
# note (docs/validation/2026-10-30-plugin-phase3.md) for how the lab was set up.
#
# usage: PROVIDER_DATA=... CONSUMER_DATA=... MAPPED_CIDR=10.66.a.b/32 \
#        PROVIDER_PORT=3425 MODEL=deepseek/deepseek-flash \
#        CONSUMER_URL=http://127.0.0.1:3425 ./mock-topup.sh
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
CLI="bun $HERE/bin/ohmyaihub.ts"
: "${PROVIDER_DATA:?}" "${CONSUMER_DATA:?}" "${MAPPED_CIDR:?}" "${MODEL:?}" "${CONSUMER_URL:?}"
PROVIDER_PORT=${PROVIDER_PORT:-3425}
CONSUMER_ID=${CONSUMER_ID:-alice}
CAP=${CAP:-0.0005}
TOPUP=${TOPUP:-1}

say() { printf '\n=== %s ===\n' "$*"; }

say "provider: one held key for $CONSUMER_ID (models $MODEL, cap \$$CAP)"
$CLI --data "$PROVIDER_DATA" consumers add "$CONSUMER_ID" "$MODEL" "$CAP"

KEY=$($CLI --data "$PROVIDER_DATA" secret "$CONSUMER_ID")
say "consumer: connect through EasyTier ($MAPPED_CIDR:$PROVIDER_PORT)"
$CLI --data "$CONSUMER_DATA" connect --id provider-a --cidr "$MAPPED_CIDR" --key "$KEY" --port "$PROVIDER_PORT"

say "consumer: models seen through Remote Magpie"
curl -sS -m 30 "$CONSUMER_URL/v1/models" | python3 -c 'import json,sys;print([m["id"] for m in json.load(sys.stdin)["data"]])' || true

chat() {
  curl -sS -m 120 -o /tmp/ohmyaihub-demo-body -w '%{http_code}' \
    -H 'content-type: application/json' \
    -d "{\"model\":\"provider-a/$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"list fifteen short words about the sea\"}],\"max_tokens\":300}" \
    "$CONSUMER_URL/v1/chat/completions"
}
usage() {
  $CLI --data "$PROVIDER_DATA" consumers | python3 -c 'import json,sys;c=json.load(sys.stdin)[0];print("used=%.8f left=%.8f calls=%d spent=%s"%(c["usedUsd"],c["leftUsd"],c["calls"],c["spent"]))'
}

say "calls until the key is spent"
for i in 1 2 3 4 5 6 7 8; do
  code=$(chat)
  printf 'call %d: HTTP %s  ' "$i" "$code"
  usage
  [ "$code" = "429" ] && break
done

say "Magpie's own refusal (provider-side key limit)"
chat
head -c 300 /tmp/ohmyaihub-demo-body; echo

say "simulated top-up \$$TOPUP on the SAME key"
$CLI --data "$PROVIDER_DATA" topup "$CONSUMER_ID" "$TOPUP"
usage

say "next call, with no consumer change at all"
printf 'HTTP %s\n' "$(chat)"
usage
