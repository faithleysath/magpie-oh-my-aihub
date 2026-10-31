#!/usr/bin/env python3
"""Disposable fixture checks; no browser, Magpie, EasyTier or public network."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

spec = importlib.util.spec_from_file_location("phase9_harness", Path(__file__).with_name("harness.py"))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class HarnessTests(unittest.TestCase):
    def test_pid_zero_is_not_a_process(self):
        self.assertFalse(h.alive(0))
        self.assertFalse(h.alive(1))

    def test_private_file_and_invalid_runtime(self):
        with tempfile.TemporaryDirectory(prefix="phase9-harness-unit-") as root:
            path = Path(root) / "runtime.json"
            h.save(path, {"secret": "fixture-only"})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(RuntimeError):
                h.load(path)

    def test_package_excludes_heavy_and_generated_content(self):
        files = [str(p) for p in h.package_files()]
        self.assertIn("package.json", files)
        self.assertIn("plugin/src/index.ts", files)
        self.assertTrue(all("node_modules" not in p for p in files))
        self.assertTrue(all(not p.endswith("page/status.js") for p in files))
        self.assertTrue(all(not p.endswith("page/options.js") for p in files))
        self.assertTrue(all(not p.endswith("page/launcher.js") for p in files))

    def test_only_the_measured_platform_binary_hash_is_enforced(self):
        # macOS arm64 0.1.2289 is the measured build: its bytes are required.
        wanted = h.measured_binary_sha("0.1.2289", "Darwin", "arm64")
        self.assertEqual(wanted, "c534dbcdb92031aa42ef6e4429d558f16d7e679b8508f82fcfde2bc07c45080c")
        h.verify_app_binary("0.1.2289", "Darwin", "arm64", wanted)
        with self.assertRaises(RuntimeError):
            h.verify_app_binary("0.1.2289", "Darwin", "arm64", "0" * 64)
        # Unmeasured platform/version combinations stay version-only (no false rejection):
        for version, system, machine in (
            ("0.1.2289", "Linux", "x86_64"),
            ("0.1.2289", "Darwin", "x86_64"),
            ("0.1.2171", "Darwin", "arm64"),
            ("0.1.2038", "Darwin", "arm64"),
        ):
            self.assertIsNone(h.measured_binary_sha(version, system, machine), (version, system, machine))
            h.verify_app_binary(version, system, machine, "0" * 64)  # never raises without a pin

    def test_only_measured_app_versions_are_accepted(self):
        # The Phase 10 target and the two earlier measured builds are allowed …
        self.assertEqual(h.measured_source_sha("0.1.2289"), "5c637f17b25dad63c490b1edf242c11a83b1b059")
        self.assertEqual(h.measured_source_sha("0.1.2171"), "244d80e23f91ab4e2b37b4e045d61fda5f7bca50")
        self.assertEqual(h.measured_source_sha("0.1.2038"), "8c63c5b7873c6aa7aa797aa17f481d5fa8301876")
        # … and anything else is refused, never silently accepted.
        for version in ("0.1.2290", "0.1.22890", "0.1.2289-beta", "", "../0.1.2289"):
            with self.assertRaises(RuntimeError, msg=version):
                h.measured_source_sha(version)

    def test_env_does_not_inherit_user_tokens_or_host_bun_override(self):
        node = {"home": "/tmp/fixture/home", "gatewayAddress": "192.0.2.1:33333", "lan": "192.0.2.1", "webKey": "fixture-key", "bin": "/tmp/fixture/Magpie.app/Contents/MacOS/magpie"}
        old = os.environ.get("OPENAI_API_KEY")
        try:
            os.environ["OPENAI_API_KEY"] = "not-real"
            env = h.env_for(node, "/tmp/fixture")
            self.assertNotIn("OPENAI_API_KEY", env)
            self.assertNotIn("MAGPIE_BUN", env)
            self.assertNotIn("mise", env["PATH"])
            self.assertEqual(env["HOME"], "/tmp/fixture/home")
        finally:
            if old is None:
                os.environ.pop("OPENAI_API_KEY", None)
            else:
                os.environ["OPENAI_API_KEY"] = old

    def test_sanitized_manifest_excludes_credentials(self):
        with tempfile.TemporaryDirectory(prefix="phase9-harness-unit-") as root:
            node = {"name": "provider", "root": str(Path(root) / "provider"), "data": str(Path(root) / "provider/data"), "lan": "127.0.0.1", "ports": {}, "processes": {}, "webKey": "do-not-export", "webLoginUrl": "http://localhost/?k=do-not-export"}
            runtime = {"root": root, "repoHead": "test", "platform": {}, "magpieVersion": "0.1.2171", "magpieSourceSha": "test", "hostBun": {}, "compatibility": "UNKNOWN", "networkSecret": "do-not-export", "nodes": {"provider": node}}
            result = json.dumps(h.audit(Path(root) / "runtime.json", runtime))
            self.assertNotIn("do-not-export", result)
            self.assertNotIn("webLoginUrl", result)
            self.assertNotIn(root, result)

    def source_fixture(self, root, github=False):
        nr = Path(root) / "provider"
        data = nr / "data"
        local = nr / "package"
        target = data / "plugins/node_modules/@oh-my-aihub/magpie-plugin" if github else local
        reference = Path(root) / "reference"
        for directory in (local, target, reference):
            for name, text in {
                "package.json": json.dumps({"name": "@oh-my-aihub/magpie-plugin", "main": "plugin/src/index.ts"}),
                "plugin/src/index.ts": "export default () => ({});",
                "plugin/src/wallet.ts": "export const fixture = true;",
                "plugin/console/app.js": "console.log('fixture');",
                "plugin/console/index.html": "<!doctype html>",
                "plugin/page/app.js": "// shipped launcher",
                "plugin/page/status.js": "do-not-export-generated-payload",
                "plugin/page/launcher.js": "do-not-export-generated-launcher",
                "plugin/console/wallet.test.js": "do-not-export-tests",
            }.items():
                file = directory / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(text)
        spec = "github:faithleysath/magpie-oh-my-aihub#feature/local-web-console" if github else str(local)
        h.save(data / "plugins.json", {"plugins": [{"spec": spec, "options": {"networkSecret": "do-not-export-options"}}]})
        if github:
            h.save(data / "plugins/package.json", {"dependencies": {"@oh-my-aihub/magpie-plugin": spec}})
            # Deliberately unused fixture copy differs from installed GitHub source.
            (local / "plugin/src/index.ts").write_text("unused fixture copy")
        return {"root": str(nr), "data": str(data), "pluginCopy": str(local), "ports": {}}, target, reference

    def test_actual_source_selects_local_or_github_without_exporting_options(self):
        for github in (False, True):
            with self.subTest(github=github), tempfile.TemporaryDirectory(prefix="phase9-source-unit-") as root:
                node, target, reference = self.source_fixture(root, github)
                selected, kind, label = h.actual_package_root(node)
                self.assertEqual(selected, target.resolve())
                self.assertEqual(kind, "github" if github else "local")
                self.assertNotIn(root, label)
                evidence = h.actual_installed_source(node, reference)
                self.assertEqual(evidence["status"], "VERIFIED")
                self.assertEqual(evidence["mismatchCount"], 0)
                self.assertIn("plugin/src/wallet.ts", evidence["files"])
                self.assertNotIn("plugin/page/status.js", evidence["files"])
                self.assertNotIn("plugin/page/launcher.js", evidence["files"])
                self.assertNotIn("plugin/console/wallet.test.js", evidence["files"])
                self.assertNotIn("do-not-export", json.dumps(evidence))
                self.assertNotIn(root, json.dumps(evidence))
                (target / "plugin/src/wallet.ts").write_text("changed installed source")
                mismatch = h.actual_installed_source(node, reference)
                self.assertEqual(mismatch["status"], "MISMATCH")
                self.assertEqual(mismatch["mismatchCount"], 1)

    def test_actual_source_refuses_paths_and_symlinks_escaping_owned_node(self):
        with tempfile.TemporaryDirectory(prefix="phase9-source-unit-") as root:
            node, target, reference = self.source_fixture(root, github=True)
            file = target / "plugin/src/wallet.ts"
            file.unlink()
            outside = Path(root) / "outside-wallet.ts"
            outside.write_text("must never be read")
            file.symlink_to(outside)
            self.assertEqual(h.actual_installed_source(node, reference)["status"], "UNKNOWN")
            self.assertNotIn("must never be read", json.dumps(h.actual_installed_source(node, reference)))
            file.unlink()
            file.write_text("export const fixture = true;")
            # Escaping installed-root symlink is refused as well as source-file links.
            import shutil
            shutil.rmtree(target)
            target.symlink_to(reference, target_is_directory=True)
            self.assertEqual(h.actual_installed_source(node, reference)["status"], "UNKNOWN")
            h.save(Path(node["data"]) / "plugins.json", {"plugins": [{"spec": str(reference)}]})
            self.assertEqual(h.actual_installed_source(node, reference)["status"], "UNKNOWN")

    def test_actual_source_rejects_wrong_entry_main_or_dependency_mapping(self):
        with tempfile.TemporaryDirectory(prefix="phase9-source-unit-") as root:
            node, target, reference = self.source_fixture(root, github=True)
            h.save(target / "package.json", {"name": "@oh-my-aihub/magpie-plugin", "main": "../outside.ts"})
            self.assertEqual(h.actual_installed_source(node, reference)["status"], "UNKNOWN")
            h.save(target / "package.json", {"name": "@oh-my-aihub/magpie-plugin", "main": "plugin/src/index.ts"})
            h.save(Path(node["data"]) / "plugins/package.json", {"dependencies": {"@oh-my-aihub/magpie-plugin": "https://evil.invalid/private-token"}})
            evidence = h.actual_installed_source(node, reference)
            self.assertEqual(evidence["status"], "UNKNOWN")
            self.assertNotIn("private-token", json.dumps(evidence))

    def test_console_port_json_is_discovered_without_returning_other_metadata(self):
        with tempfile.TemporaryDirectory(prefix="phase9-source-unit-") as root:
            node, _, _ = self.source_fixture(root)
            h.save(Path(node["data"]) / "oh-my-aihub/console-port.json", {"port": 52754, "secret": "do-not-export"})
            self.assertEqual(h.observed_ports(node)["console-port"], 52754)
            self.assertNotIn("do-not-export", json.dumps(h.observed_ports(node)))

    def test_mock_is_local_deterministic_and_counted(self):
        port = h.free_port(["127.0.0.1"], set())
        p = subprocess.Popen([sys.executable, str(Path(__file__).with_name("mock-upstream.py")), "--port", str(port), "--name", "unit"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.assertTrue(h.wait_status(f"http://127.0.0.1:{port}/v1/models", 200, 5))
            request = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions", data=json.dumps({"model": "unit-model"}).encode(), headers={"Content-Type": "application/json"})
            with h.HTTP.open(request) as response:
                body = json.load(response)
            self.assertEqual(body["usage"]["total_tokens"], 12)
            with h.HTTP.open(f"http://127.0.0.1:{port}/count") as response:
                self.assertEqual(json.load(response)["requests"], 1)
        finally:
            p.terminate()
            p.wait(timeout=5)
        self.assertTrue(h.port_free(port, "127.0.0.1"))


if __name__ == "__main__":
    unittest.main()
