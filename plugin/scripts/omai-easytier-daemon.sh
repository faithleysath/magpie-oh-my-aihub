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

# Every field is checked against the table it belongs to, not only the table
# name. The config the plugin generates uses a small, known vocabulary; a
# tampered file cannot use this daemon as root to open a privileged listener,
# export a subnet, turn on exit-node traffic or widen the ACL.
#
# sh rather than awk on purpose: bracket-heavy regexes in awk differ between
# implementations, and a validator that silently accepts everything is worse than
# no validator.
allowed_key() {
  case "$1" in
    instance_name|hostname|dhcp|peer|listeners|socks5_proxy) return 0 ;;
    *) return 1 ;;
  esac
}

allowed_table() {
  case "$1" in
    network_identity|flags|secure_mode|acl.acl_v1|acl.acl_v1.chains|acl.acl_v1.chains.rules|port_forward) return 0 ;;
    *) return 1 ;;
  esac
}

allowed_field() {
  case "$1:$2" in
    network_identity:network_name|network_identity:network_secret) return 0 ;;
    flags:no_tun) return 0 ;;
    secure_mode:enabled|secure_mode:local_private_key|secure_mode:local_public_key) return 0 ;;
    acl.acl_v1.chains:name|acl.acl_v1.chains:chain_type|acl.acl_v1.chains:enabled|acl.acl_v1.chains:default_action) return 0 ;;
    acl.acl_v1.chains.rules:name|acl.acl_v1.chains.rules:priority|acl.acl_v1.chains.rules:enabled) return 0 ;;
    acl.acl_v1.chains.rules:protocol|acl.acl_v1.chains.rules:ports|acl.acl_v1.chains.rules:action|acl.acl_v1.chains.rules:stateful) return 0 ;;
    port_forward:bind_addr|port_forward:dst_addr|port_forward:proto) return 0 ;;
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
  table=""
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    case "$line" in
      '['*)
        intable=1
        table=$(printf '%s' "$line" | sed -e 's/^\[\[//' -e 's/^\[//' -e 's/\]\]$//' -e 's/\]$//')
        allowed_table "$table" || { printf 'refused table: %s\n' "$line"; bad=1; }
        ;;
      *)
        key=$(printf '%s' "$line" | sed -e 's/[[:space:]]*=.*$//' -e 's/[[:space:]]*$//')
        if [ "$intable" = 1 ]; then
          allowed_field "$table" "$key" || { printf 'refused field in %s: %s\n' "$table" "$line"; bad=1; }
        else
          allowed_key "$key" || { printf 'refused key: %s\n' "$line"; bad=1; }
        fi
        # A root-run core may not bind a privileged port, whatever the file says.
        if [ "$intable" = 0 ] && [ "$key" = "listeners" ]; then
          for port in $(printf '%s' "$line" | grep -oE ':[0-9]{1,5}' | tr -d ':'); do
            if [ "$port" -lt 1024 ]; then
              printf 'refused privileged listener port: %s\n' "$line"
              bad=1
            fi
          done
        fi
        # The generated ACL never widens beyond denying by default and allowing
        # only the directory/gateway; a tampered rule is refused.
        if [ "$table" = "acl.acl_v1.chains" ] && [ "$key" = "default_action" ]; then
          case "$line" in
            *"= 2") ;;
            *) printf 'refused ACL default action: %s\n' "$line"; bad=1 ;;
          esac
        fi
        if [ "$table" = "acl.acl_v1.chains.rules" ] && [ "$key" = "protocol" ]; then
          case "$line" in
            *"= 1") ;;
            *) printf 'refused ACL protocol: %s\n' "$line"; bad=1 ;;
          esac
        fi
        if [ "$table" = "acl.acl_v1.chains.rules" ] && [ "$key" = "action" ]; then
          case "$line" in
            *"= 1") ;;
            *) printf 'refused ACL action: %s\n' "$line"; bad=1 ;;
          esac
        fi
        if [ "$table" = "acl.acl_v1.chains.rules" ] && [ "$key" = "ports" ]; then
          case "$line" in
            *'"3425"'*|*'"3426"'*) ;;
            *) printf 'refused ACL ports: %s\n' "$line"; bad=1 ;;
          esac
        fi
        # The SOCKS portal is this node's own loopback helper; never public.
        if [ "$intable" = 0 ] && [ "$key" = "socks5_proxy" ]; then
          case "$line" in
            *socks5://127.0.0.1:*) ;;
            *) printf 'refused non-loopback SOCKS proxy: %s\n' "$line"; bad=1 ;;
          esac
        fi
        # Consumer forwards are loopback listeners; never a public bind.
        if [ "$table" = "port_forward" ] && [ "$key" = "bind_addr" ]; then
          case "$line" in
            *127.0.0.1:*) ;;
            *) printf 'refused non-loopback forward: %s\n' "$line"; bad=1 ;;
          esac
        fi
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
