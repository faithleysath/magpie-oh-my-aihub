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
