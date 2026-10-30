#!/usr/bin/env python3
"""Maintainer-only isolated real Magpie fixture. Never drives product journeys.

Commands print private runtime.json's path, never credentials or login/ticket URLs.
The actor installs/enables the plugin in Magpie's GUI and uses the real console.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO = Path(__file__).resolve().parents[4]
SCRIPT = Path(__file__).resolve().parent
MARKER = "ohmyaihub-phase9-isolated-lab/v1"
NAMES = ("provider", "consumer", "provider2")
ET_PIN = {
    "easytier-core": "6478a522b8637e2bd2ad3adad66ed04a71b35f832bd9889bffaf1863262f6ddf",
    "easytier-cli": "c700c4fee1a7f35fcc1a048520d40cea477b6cf7bf6d75f423fe1642c1ebc75d",
}
ET_ZIP = "4be1882d1aa36d31c1d6ba0596f2cf8a097e371f8da124212324b2e0f8df7e4b"
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def save(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    path.chmod(0o600)


def digest(path: Path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def load(runtime: Path):
    runtime = runtime.resolve()
    data = json.loads(runtime.read_text())
    if data.get("schema") != MARKER or runtime.parent != Path(data["root"]).resolve():
        raise RuntimeError("not a phase9 lab runtime")
    if not str(runtime.parent).startswith("/private/tmp/") and not str(runtime.parent).startswith("/tmp/"):
        raise RuntimeError("lab must be under /tmp")
    return runtime, data


def run(cmd, *, env=None, cwd=None, timeout=30):
    return subprocess.run([str(c) for c in cmd], cwd=cwd, env=env, timeout=timeout,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


def env_for(node, root):
    # Do not inherit user API tokens, proxy credentials, MAGPIE_* or real HOME.
    return {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": node["home"], "TMPDIR": str(Path(root) / "tmp"),
        "XDG_CONFIG_HOME": str(Path(node["home"]) / ".config"),
        "XDG_CACHE_HOME": str(Path(node["home"]) / ".cache"),
        "MAGPIE_NO_ACCOUNTS": "1", "MAGPIE_TRUST_PROXY": "0",
        "MAGPIE_ADDR": node["gatewayAddress"], "MAGPIE_ALLOW_IPS": node["lan"] + "/32",
        "MAGPIE_WEB_KEY": node["webKey"], "OH_MY_AIHUB_MAGPIE": node["bin"],
        "LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8",
    }


def request_status(url, *, headers=None):
    try:
        request = urllib.request.Request(url, headers=headers or {})
        with HTTP.open(request, timeout=2) as response:
            return response.status
    except urllib.error.HTTPError as e:
        return e.code
    except (OSError, urllib.error.URLError, TimeoutError):
        return 0


def wait_status(url, expected, timeout=35):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if request_status(url) == expected:
            return True
        time.sleep(.2)
    return False


def lan_ip():
    # No public network request: UDP connect only asks the kernel for its route.
    for interface in ("en0", "en1", "eth0"):
        result = run(["/usr/sbin/ipconfig", "getifaddr", interface])
        address = result.stdout.decode().strip()
        if result.returncode == 0 and address and not address.startswith("127."):
            return address
    raise RuntimeError("no usable LAN IPv4; pass --lan explicitly")


def free_port(hosts, used):
    for _ in range(500):
        port = 20000 + secrets.randbelow(35000)
        if port in used:
            continue
        sockets = []
        try:
            for host in hosts:
                s = socket.socket()
                sockets.append(s)
                s.bind((host, port))
            used.add(port)
            return port
        except OSError:
            pass
        finally:
            for s in sockets:
                s.close()
    raise RuntimeError("could not allocate private lab ports")


def free_window(lan, used):
    for _ in range(400):
        base = free_port(["127.0.0.1", lan], used)
        sockets = []
        try:
            for port in range(base + 1, base + 5):
                if port in used or port > 65535:
                    raise OSError("reserved")
                for host in ("127.0.0.1", lan):
                    s = socket.socket()
                    sockets.append(s)
                    s.bind((host, port))
            used.update(range(base, base + 5))
            return base
        except OSError:
            pass
        finally:
            for s in sockets:
                s.close()
    raise RuntimeError("could not allocate catalogue window")


def package_files():
    # Root layout preserved, including all production plugin files; no heavy dev deps.
    files = []
    for name in ("package.json", "README.md", "LICENSE"):
        if (REPO / name).is_file():
            files.append(Path(name))
    for root, dirs, names in os.walk(REPO / "plugin"):
        dirs[:] = [d for d in dirs if d not in {"node_modules", ".git", "test", "lab", "scripts"}]
        for name in names:
            p = Path(root) / name
            rel = p.relative_to(REPO)
            if name in {"status.js", "options.js", "launcher.js", "bun.lock", ".DS_Store"} or name.endswith(".tmp"):
                continue
            if p.is_file() and not p.is_symlink():
                files.append(rel)
    return sorted(files)


def sync_package(node):
    target = Path(node["pluginCopy"])
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    files = package_files()
    wanted = {str(p) for p in files}
    # Refresh deletes retired shipped files, but never generated page status/options.
    for root, _, names in os.walk(target):
        for name in names:
            p = Path(root) / name
            rel = str(p.relative_to(target))
            if rel not in wanted and name not in {"status.js", "options.js", "launcher.js"}:
                p.unlink()
    hashes = {}
    for rel in files:
        src, dest = REPO / rel, target / rel
        dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copy2(src, dest)
        hashes[str(rel)] = digest(dest)
    save(Path(node["root"]) / "copy-manifest.json", {"schema": MARKER, "files": hashes, "at": stamp()})
    return hashes


def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def prepare(args):
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise RuntimeError("this measured harness currently supports macOS arm64 only")
    app = Path(args.app).resolve()
    if not (app / "Contents/MacOS/magpie").is_file():
        raise RuntimeError("Magpie source bundle not found")
    with (app / "Contents/Info.plist").open("rb") as f:
        version = plistlib.load(f)["CFBundleShortVersionString"]
    if version not in {"0.1.2171", "0.1.2038"}:
        raise RuntimeError("unmeasured app version: use 0.1.2171 or 0.1.2038 explicitly")
    if not (REPO / "package.json").is_file():
        raise RuntimeError("root installable package.json is required")
    root = Path(args.root or f"/tmp/ohmyaihub-phase9-real-{secrets.token_hex(4)}").resolve()
    if root.exists():
        raise RuntimeError("refusing existing lab root; fresh profiles must not inherit state")
    if not str(root).startswith("/private/tmp/") and not str(root).startswith("/tmp/"):
        raise RuntimeError("lab root must be under /tmp")
    root.mkdir(mode=0o700)
    (root / "tmp").mkdir(mode=0o700)
    lan = args.lan or lan_ip()
    socket.inet_aton(lan)
    used = set()
    catalog = free_window(lan, used)
    runtime = {"schema": MARKER, "root": str(root), "createdAt": stamp(),
               "repoHead": run(["git", "rev-parse", "HEAD"], cwd=REPO).stdout.decode().strip(),
               "platform": {"os": platform.system(), "release": platform.release(), "arch": platform.machine()},
               "magpieSourceSha": "244d80e23f91ab4e2b37b4e045d61fda5f7bca50" if version == "0.1.2171" else None,
               "magpieVersion": version, "billingPin": "0.1.2038",
               "compatibility": "UNKNOWN until actor acceptance", "networkName": "phase9-" + secrets.token_hex(4),
               "networkSecret": secrets.token_hex(24), "nodes": {}}
    # This is Magpie-managed Bun, never a userflow dependency or PATH Bun override.
    bun_source = Path(args.host_bun).resolve()
    bun_result = run([bun_source, "--version"])
    if bun_result.returncode:
        raise RuntimeError("Magpie-managed Bun cache is not executable")
    bun_version = bun_result.stdout.decode().strip()
    runtime["hostBun"] = {"version": bun_version, "sha256": digest(bun_source), "origin": "Magpie-managed cache fixture"}
    et_source = Path(args.easytier_cache).resolve()
    for file, wanted in ET_PIN.items():
        if not (et_source / file).is_file() or digest(et_source / file) != wanted:
            raise RuntimeError("EasyTier fixture does not match measured v2.6.4 binary hashes")
    for index, name in enumerate(NAMES[:args.nodes]):
        nr = root / name
        nr.mkdir(mode=0o700)
        (nr / ".portable").touch(mode=0o600)
        data, home = nr / "data", nr / "home"
        data.mkdir(mode=0o700)
        home.mkdir(mode=0o700)
        logs = nr / "logs"
        logs.mkdir(mode=0o700)
        # Small app bundle only (62 MiB); never copy original data next to it.
        shutil.copytree(app, nr / "Magpie.app", symlinks=True)
        web = free_port(["127.0.0.1", lan], used)
        gateway = free_port(["127.0.0.1", lan], used)
        upstream = free_port(["127.0.0.1"], used)
        node = {"name": name, "root": str(nr), "data": str(data), "home": str(home), "logs": str(logs),
                "bin": str(nr / "Magpie.app/Contents/MacOS/magpie"), "lan": lan,
                "gatewayAddress": f"{lan}:{gateway}", "pluginCopy": str(nr / "package"),
                "webKey": secrets.token_hex(24), "webOrigin": f"http://127.0.0.1:{web}",
                "ports": {"web": web, "gateway": gateway, "upstream": upstream,
                          "listen": free_port(["127.0.0.1", lan], used),
                          "catalog": catalog + (1 if index == 0 else 0 if index == 1 else 2),
                          "socks": free_port(["127.0.0.1", lan], used)},
                "processes": {}, "fixture": {"model": f"{name}/{name}-model", "price": "1000,1000,0,0"}}
        node["webLoginUrl"] = node["webOrigin"] + "/?k=" + node["webKey"]
        runtime["nodes"][name] = node
        save(root / "runtime.json", runtime)  # Preserve partial setup for cleanup.
        save(data / "settings.json", {"lan": True, "port": gateway, "noAccountDiscovery": True,
                                       "noAutoUpdate": True, "noAutoDownload": True, "autoRestart": False})
        bun_dest = data / "cache/bun" / bun_version / "magpie-bun"
        bun_dest.parent.mkdir(parents=True, mode=0o700)
        shutil.copy2(bun_source, bun_dest)
        bun_dest.chmod(0o755)
        save(data / "cache/bun/state.json", {"current": bun_version, "checked": stamp()})
        # Pinned cache only; does not create node/config/plugin installation.
        et = data / "oh-my-aihub/easytier/v2.6.4/darwin-arm64"
        et.mkdir(parents=True, mode=0o700)
        for file in ET_PIN:
            shutil.copy2(et_source / file, et / file)
            (et / file).chmod(0o755)
        (et / ".sha256").write_text(ET_ZIP + "\n")
        (et / ".sha256").chmod(0o600)
        save(et / ".binaries.json", {"version": "2.6.4", "zip": ET_ZIP, **{k.split("-")[-1]: v for k, v in ET_PIN.items()}})
        sync_package(node)
        fixture_env = env_for(node, root)
        commands = [
            ["provider", "add", name, f"url=http://127.0.0.1:{upstream}/v1", f"key=sk-fixture-{name}-not-a-vendor-key", f"models={name}-model", f"name={name}"],
            ["model", "price", node["fixture"]["model"], node["fixture"]["price"]],
        ]
        for command in commands:
            result = run([node["bin"], *command], env=fixture_env, cwd=data, timeout=60)
            if result.returncode:
                # Raw CLI output only inside private root, never on terminal.
                (logs / "fixture-error.log").write_bytes(result.stdout + result.stderr)
                (logs / "fixture-error.log").chmod(0o600)
                raise RuntimeError(f"{name} mock-provider fixture failed; private log retained")
        providers = json.loads((data / "providers.json").read_text())
        node["fixture"]["portableProviderFileExists"] = bool(providers)
        node["binarySha256"] = digest(Path(node["bin"]))
        save(root / "runtime.json", runtime)
    audit(root / "runtime.json", runtime)
    print(root / "runtime.json")


def spawn(node, role, command, root):
    logfile = Path(node["logs"]) / f"{role}.log"
    fd = os.open(logfile, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "ab", buffering=0) as output:
        p = subprocess.Popen([str(c) for c in command], cwd=node["data"], env=env_for(node, root),
                             stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
    node["processes"][role] = {"pid": p.pid, "startedAt": stamp(), "argv0": str(command[0])}
    return p


def alive(pid):
    if int(pid) <= 1:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError):
        return False


def start_node(runtime_path, runtime, name):
    node = runtime["nodes"][name]
    upstream = node["ports"]["upstream"]
    if not alive(node["processes"].get("upstream", {}).get("pid", 0)):
        spawn(node, "upstream", [sys.executable, SCRIPT / "mock-upstream.py", "--port", upstream, "--name", name], runtime["root"])
        save(runtime_path, runtime)
    if not wait_status(f"http://127.0.0.1:{upstream}/v1/models", 200, 10):
        raise RuntimeError(f"{name} mock upstream failed; see private log")
    if not alive(node["processes"].get("web", {}).get("pid", 0)):
        # One process owns both real Magpie UI and its gateway/plugin host.
        spawn(node, "web", [node["bin"], "web", "--addr", f"127.0.0.1:{node['ports']['web']}", "--no-open"], runtime["root"])
        save(runtime_path, runtime)
    deadline = time.monotonic() + 35
    web_ready = False
    while time.monotonic() < deadline:
        if request_status(node["webOrigin"]) in {200, 302, 303, 401, 403}:
            web_ready = True
            break
        time.sleep(.2)
    gateway_ready = wait_status(f"http://{node['gatewayAddress']}/v1/models", 401, 35)
    with socket.socket() as probe:
        probe.settimeout(.5)
        web_loopback_only = probe.connect_ex((node["lan"], node["ports"]["web"])) != 0
    node["readiness"] = {"at": stamp(), "webReachable": web_ready,
                         "webLoopbackOnly": web_loopback_only,
                         "gatewayNoKeyStatus": request_status(f"http://{node['gatewayAddress']}/v1/models"),
                         "gatewayWrongKeyStatus": request_status(f"http://{node['gatewayAddress']}/v1/models", headers={"Authorization": "Bearer invalid-fixture-key"}),
                         "pluginInstalledByHarness": False}
    save(runtime_path, runtime)
    audit(runtime_path, runtime)
    if not web_ready or not gateway_ready or not web_loopback_only or node["readiness"]["gatewayWrongKeyStatus"] != 401:
        raise RuntimeError(f"{name} real UI/gateway did not meet loopback/key enforcement checks; see private log")


def table():
    raw = run(["/bin/ps", "-axo", "pid=,ppid=,command="]).stdout.decode()
    rows = []
    for line in raw.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            rows.append((int(parts[0]), int(parts[1]), parts[2]))
    return rows


def owned_pids(node):
    rows = table()
    # Match live argv, not a remembered PID that might have been reused.
    seeds = {pid for pid, _, cmd in rows if node["root"] + "/" in cmd and pid != os.getpid()}
    upstream = node["processes"].get("upstream", {}).get("pid")
    for pid, _, cmd in rows:
        if (pid == upstream and str(SCRIPT / "mock-upstream.py") in cmd
                and f"--port {node['ports']['upstream']}" in cmd and f"--name {node['name']}" in cmd):
            seeds.add(pid)
    while True:
        extra = {pid for pid, parent, _ in rows if parent in seeds and pid != os.getpid()}
        if extra.issubset(seeds):
            break
        seeds.update(extra)
    return seeds - {os.getpid()}


def stop_node(node):
    pids = owned_pids(node)
    # A remembered PID is killed only while its argv belongs to the lab.
    by_id = {pid: cmd for pid, _, cmd in table()}
    for pid in pids:
        # owned_pids already checked current argv and descendants. Recheck the
        # unchanged argv immediately before signalling, guarding PID reuse.
        current = {p: cmd for p, _, cmd in table()}.get(pid)
        if current and current == by_id.get(pid):
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline and any(alive(pid) for pid in pids):
        time.sleep(.1)
    for pid in pids:
        if alive(pid):
            current = {p: cmd for p, _, cmd in table()}.get(pid, "")
            if current and current == by_id.get(pid):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
    node["processes"] = {}
    return {"before": sorted(pids), "remaining": sorted(owned_pids(node)),
            "portsFree": {key: port_free(port, node["lan"]) for key, port in observed_ports(node).items()}}


def port_free(port, lan):
    for host in ("127.0.0.1", lan):
        with socket.socket() as s:
            s.settimeout(.15)
            if s.connect_ex((host, int(port))) == 0:
                return False
    return True


def observed_ports(node):
    ports = dict(node["ports"])
    state = Path(node["data"]) / "oh-my-aihub"
    for name in ("api-port", "console-port"):
        try:
            value = int((state / name).read_text().strip())
            if 0 < value < 65536:
                ports[name] = value
        except (OSError, ValueError):
            pass
    try:
        config = json.loads((state / "state.json").read_text()).get("config") or {}
        rpc = config.get("rpcPort")
        if isinstance(rpc, int) and 0 < rpc < 65536:
            ports["rpc"] = rpc
    except (OSError, ValueError):
        pass
    return ports


def audit(runtime_path, runtime, cleanup=None):
    # Explicit allowlist: no keys, invitation, login URLs, private paths, bodies.
    report = {"schema": MARKER, "at": stamp(), "repoHead": runtime["repoHead"],
              "platform": runtime["platform"], "magpieVersion": runtime["magpieVersion"],
              "magpieSourceSha": runtime["magpieSourceSha"], "hostBun": runtime["hostBun"],
              "billingPin": "0.1.2038", "compatibility": runtime["compatibility"],
              "easytier": {"version": "2.6.4", "commit": "8428a89d2dabc94c97d370ec607c6ca142473626", "binaryHashes": ET_PIN},
              "nodes": {}, "cleanup": cleanup,
              "constraints": {"pluginInstallByGUI": True, "businessOperationsByHarness": False,
                              "publicChainWrites": False, "browserLaunchedByHarness": False}}
    for name, node in runtime["nodes"].items():
        manifest = Path(node["root"]) / "copy-manifest.json"
        report["nodes"][name] = {"ports": observed_ports(node), "binarySha256": node.get("binarySha256"),
                                  "readiness": node.get("readiness"),
                                  "runningPids": sorted(owned_pids(node)),
                                  "package": json.loads(manifest.read_text()) if manifest.exists() else None}
    save(Path(runtime["root"]) / "sanitized-manifest.json", report)
    return report


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    p = subs.add_parser("prepare")
    p.add_argument("--root")
    p.add_argument("--app", default="/Applications/magpie.app")
    p.add_argument("--host-bun", default=str(Path.home() / ".cache/magpie/bun/1.4.4/magpie-bun"))
    p.add_argument("--easytier-cache", default=str(Path.home() / "Projects/lab/et/easytier-macos-aarch64"))
    p.add_argument("--lan")
    p.add_argument("--nodes", type=int, choices=[1, 2, 3], default=3)
    for name in ("start", "stop", "refresh-copy", "status", "cleanup", "export-evidence"):
        q = subs.add_parser(name)
        q.add_argument("--runtime", type=Path, required=True)
        q.add_argument("--node", choices=[*NAMES, "all"], default="provider")
        if name == "refresh-copy":
            q.add_argument("--restart", action="store_true")
        if name == "export-evidence":
            q.add_argument("--out", type=Path, required=True)
        if name == "cleanup":
            q.add_argument("--delete", action="store_true")
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args)
        return
    path, runtime = load(args.runtime)
    names = list(runtime["nodes"]) if args.node == "all" else [args.node]
    if any(n not in runtime["nodes"] for n in names):
        raise RuntimeError("requested node was not prepared")
    if args.command == "start":
        for name in names:
            start_node(path, runtime, name)
    elif args.command in {"stop", "cleanup"}:
        if args.command == "cleanup":
            names = list(runtime["nodes"])
        result = {name: stop_node(runtime["nodes"][name]) for name in names}
        runtime["lastCleanup"] = {"at": stamp(), "nodes": result}
        save(path, runtime)
        audit(path, runtime, runtime["lastCleanup"])
        if args.command == "cleanup" and args.delete:
            if any(r["remaining"] or not all(r["portsFree"].values()) for r in result.values()):
                raise RuntimeError("owned process/listener remains; refusing to delete evidence")
            # Keep sanitized proof outside removed runtime root.
            proof = path.parent.with_name(path.parent.name + "-cleanup.json")
            save(proof, json.loads((path.parent / "sanitized-manifest.json").read_text()))
            shutil.rmtree(path.parent)
            print(proof)
            return
    elif args.command == "refresh-copy":
        for name in names:
            node = runtime["nodes"][name]
            was_running = bool(owned_pids(node))
            if was_running and not args.restart:
                raise RuntimeError("stop node first or pass --restart; never change a live imported package")
            if was_running:
                stop_node(node)
            sync_package(node)
            if was_running:
                start_node(path, runtime, name)
        save(path, runtime)
        audit(path, runtime)
    elif args.command == "export-evidence":
        report = audit(path, runtime, runtime.get("lastCleanup"))
        save(args.out, report)
    else:
        audit(path, runtime, runtime.get("lastCleanup"))
    print(path)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # No raw subprocess output, credential-bearing URL or environment dump.
        print(f"phase9 harness failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
