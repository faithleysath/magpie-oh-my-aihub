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
chmod 755 "$STATE"
if [ -f "$STATE/daemon.log" ]; then chmod 644 "$STATE/daemon.log"; fi
if [ -f "$STATE/core.log" ]; then chmod 600 "$STATE/core.log"; fi

# Only the prologue of the document (everything before the first table) is checked
# against an allowlist, and every table name is checked as well. Inside a table the
# keys belong to that table, which the name already bounds. Between the two, a
# config cannot grow into a request for root to open a VPN portal, export a subnet
# or exit-node traffic on someone's behalf.
#
# sh rather than awk on purpose: bracket-heavy regexes in awk differ between
# implementations, and a validator that silently accepts everything is worse than
# no validator.
allowed_key() {
  case "$1" in
    instance_name|instance_id|hostname|dhcp|ipv4|peer|listeners|mapped_listeners|socks5_proxy) return 0 ;;
    *) return 1 ;;
  esac
}

allowed_table() {
  case "$1" in
    network_identity|flags|secure_mode|acl.acl_v1|acl.acl_v1.chains|acl.acl_v1.chains.rules|port_forward) return 0 ;;
    *) return 1 ;;
  esac
}

# Diagnostics land in a directory this user can read: a daemon that exits instead of
# starting must be explainable without a second password prompt. The core's own log
# stays root-only — EasyTier prints its config, secret included, at start-up.
log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >>"$STATE/daemon.log"
}

validate() {
  bad=0
  intable=0
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    case "$line" in
      '['*)
        intable=1
        name=$(printf '%s' "$line" | sed -e 's/^\[\[//' -e 's/^\[//' -e 's/\]\]$//' -e 's/\]$//')
        allowed_table "$name" || { printf 'refused table: %s\n' "$line"; bad=1; }
        ;;
      *)
        [ "$intable" = 1 ] && continue
        key=$(printf '%s' "$line" | sed -e 's/[[:space:]]*=.*$//' -e 's/[[:space:]]*$//')
        allowed_key "$key" || { printf 'refused key: %s\n' "$line"; bad=1; }
        ;;
    esac
  done < "$1"
  [ "$bad" = 0 ]
}

log "argv: $*"
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
