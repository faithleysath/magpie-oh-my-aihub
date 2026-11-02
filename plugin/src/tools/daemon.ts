// network_daemon: the root helper that lets a user-level node run a TUN device.
//
// macOS only, and only where a device is wanted. Installing asks for the
// administrator password through the standard sheet; everything after that is a
// file write, because the daemon watches the config and restarts the core itself.

import { daemonStatus, installDaemon, uninstallDaemon } from "../daemon.ts";
import { currentTomlPath, ensureBinaries, RPC_PORT } from "../overlay.ts";
import { getRuntime } from "../runtime.ts";
import { fail, jsonText, objectArgs, type ToolDef } from "./types.ts";

const ACTIONS = ["status", "install", "uninstall"] as const;
/** The tool timeout is 55s; an admin prompt or a first download can outlast it. */
const INSTALL_GRACE_MS = 2_000;

let installJob: Promise<void> | null = null;
let installError: string | null = null;
let installStartedAt: number | null = null;

function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function takeInstallError(): string | null {
  const value = installError;
  installError = null;
  return value;
}

function installState(): Record<string, unknown> {
  return {
    ...(installJob ? { installing: true, installStartedAt } : { installing: false }),
    ...(installError ? { installError } : {}),
  };
}

export const networkDaemonTool: ToolDef = {
  description:
    "管理让 EasyTier 以 root 跑 TUN 设备的系统守护进程（macOS）。" +
    "status 只看状态；install 会弹出系统管理员密码框，装一个 LaunchDaemon，" +
    "之后本机就能用 TUN 模式（对端源地址是真地址，Gateway Key 才有意义）；uninstall 删除它。" +
    "install 先做二进制下载，可能超过工具超时，返回 state:starting 后用 status 轮询。" +
    "没有 root、又不想装这个守护进程时，节点会继续以 no-TUN 运行。",
  args: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ACTIONS], description: "默认 status" },
    },
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const action = args.action === undefined || args.action === null ? "status" : args.action;
    if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
      fail("E_INPUT", `action must be one of ${ACTIONS.join(", ")}`);
    }

    if (action === "status") {
      const status = daemonStatus();
      return jsonText({ ...status, mode: (await getRuntime()).overlay.status().mode, ...installState() });
    }

    if (process.platform !== "darwin") {
      fail("E_PLATFORM", "the root daemon exists for macOS; on Linux run magpie as root or a system unit");
    }

    if (action === "uninstall") {
      if (installJob) fail("E_BUSY", "an install is still running; poll status before uninstalling");
      try {
        await uninstallDaemon();
      } catch (error) {
        fail("E_ROOT", shortError(error));
      }
      return jsonText({ ok: true, action, ...daemonStatus() });
    }

    if (installJob) {
      return jsonText({ ok: false, state: "starting", action, ...daemonStatus(), ...installState() });
    }

    // The download and the administrator prompt can each outlast the 55-second
    // tool budget. Run the install in the background and answer as soon as it
    // has had a short chance to finish; `status` reports the rest.
    installError = null;
    installStartedAt = Date.now();
    const job = (async () => {
      try {
        const core = (await ensureBinaries(() => undefined)).core;
        await installDaemon(core, currentTomlPath(), `127.0.0.1:${RPC_PORT}`);
      } catch (error) {
        installError = shortError(error);
      } finally {
        installJob = null;
      }
    })();
    installJob = job;
    const finished = await Promise.race([job.then(() => true), sleep(INSTALL_GRACE_MS).then(() => false)]);
    if (!finished) {
      return jsonText({
        ok: false,
        state: "starting",
        action,
        ...daemonStatus(),
        ...installState(),
        note: "an administrator prompt may still be open; poll status until installing is false",
      });
    }
    const message = takeInstallError();
    if (message) {
      const code = message.startsWith("E_CANCELLED") ? "E_CANCELLED" : "E_ROOT";
      fail(code, message.replace(/^E_[A-Z_]+:\s*/, ""));
    }
    return jsonText({
      ok: true,
      action,
      ...daemonStatus(),
      note: "run join_network again so the node restarts under the daemon",
    });
  },
};
