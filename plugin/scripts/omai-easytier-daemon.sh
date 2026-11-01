#!/bin/sh
# Runs EasyTier as root, on behalf of a user-level plugin.
#
# Launchd owns this script; the plugin never gets root. The contract is a file:
# the plugin writes `current.toml` (as its own user), this script validates it,
# copies it somewhere only root can write, and runs the core from that copy. A
# changed hash restarts the core, so a `join_network` needs no privilege at all.
#
# Why the copy: a root process must not execute against a file any process of
# that user can rewrite between the check and the exec. The allowlist below is
# the second half of the same idea — a config that only names the keys the plugin
# generates cannot ask root to open a VPN portal, export a subnet or exit-node
# traffic on someone's behalf.
#
# usage: omai-easytier-daemon <plugin-config> <easytier-core> <rpc-addr>

set -eu

CFG=${1:?plugin config path}
CORE=${2:?easytier-core path}
RPC=${3:?rpc address}

STATE=/var/run/omai-easytier
mkdir -p "$STATE"
chmod 700 "$STATE"

# Keys the plugin generates. Anything else at top level is refused, so a
# hand-edited or hostile config cannot turn this into a general-purpose root VPN.
ALLOWED='^(instance_name|instance_id|hostname|dhcp|ipv4|peer|listeners|mapped_listeners|socks5_proxy|network_identity|flags|secure_mode|acl|port_forward)[[:space:]]*='

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >>"$STATE/daemon.log"; }

validate() {
  # Comments and blank lines are fine; table headers are fine; everything else
  # must be an allowed key.
  awk -v allowed="$ALLOWED" '
    /^[[:space:]]*(#|$)/ { next }
    /^[[:space:]]*\[/     { next }
    $0 !~ allowed         { print "refused key: " $0; bad = 1 }
    END                   { exit bad ? 1 : 0 }
  ' "$1"
}

PID=""
HASH=""
cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT

while :; do
  if [ -f "$CFG" ]; then
    NEW=$(shasum -a 256 "$CFG" | awk '{print $1}')
    if [ "$NEW" != "$HASH" ]; then
      if REASON=$(validate "$CFG" 2>&1); then
        install -m 0600 -o root -g wheel "$CFG" "$STATE/current.toml"
        HASH=$NEW
        if [ -n "$PID" ]; then
          kill "$PID" 2>/dev/null || true
          wait "$PID" 2>/dev/null || true
        fi
        log "starting $CORE (config $NEW)"
        "$CORE" -c "$STATE/current.toml" -r "$RPC" >>"$STATE/core.log" 2>&1 &
        PID=$!
      else
        # Keep the running core; say why the new document was refused.
        HASH=$NEW
        log "refused config: $REASON"
      fi
    fi
  fi
  # A core that exits on its own (bad key, port taken) is restarted with the same
  # config; the plugin sees the same state it would from its own supervisor.
  if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
    log "core exited; restarting"
    PID=""
    HASH=""
    sleep 2
  fi
  sleep 2
done
