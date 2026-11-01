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

function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";
}

export const networkDaemonTool: ToolDef = {
  description:
    "管理让 EasyTier 以 root 跑 TUN 设备的系统守护进程（macOS）。" +
    "status 只看状态；install 会弹出系统管理员密码框，装一个 LaunchDaemon，" +
    "之后本机就能用 TUN 模式（对端源地址是真地址，Gateway Key 才有意义）；uninstall 删除它。" +
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
      return jsonText({ ...status, mode: (await getRuntime()).overlay.status().mode });
    }

    if (process.platform !== "darwin") {
      fail("E_PLATFORM", "the root daemon exists for macOS; on Linux run magpie as root or a system unit");
    }

    if (action === "uninstall") {
      try {
        await uninstallDaemon();
      } catch (error) {
        fail("E_ROOT", shortError(error));
      }
      return jsonText({ ok: true, action, ...daemonStatus() });
    }

    // install: the core has to exist before a daemon is told to run it.
    let core: string;
    try {
      core = (await ensureBinaries((message) => undefined)).core;
    } catch (error) {
      fail("E_NETWORK", `cannot prepare the EasyTier binary: ${shortError(error)}`);
    }
    try {
      await installDaemon(core, currentTomlPath(), `127.0.0.1:${RPC_PORT}`);
    } catch (error) {
      fail(error instanceof Error && error.message.startsWith("E_CANCELLED") ? "E_CANCELLED" : "E_ROOT", shortError(error));
    }
    return jsonText({
      ok: true,
      action,
      ...daemonStatus(),
      note: "run join_network again so the node restarts under the daemon",
    });
  },
};
