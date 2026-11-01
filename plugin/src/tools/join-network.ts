// join_network: write the v3 config, then start or restart the overlay.

import { writeConfig, type NetworkConfig } from "../config.ts";
import { getRuntime } from "../runtime.ts";
import { fail, jsonText, objectArgs, optionalString, requiredString, type ToolDef } from "./types.ts";

export const joinNetworkTool: ToolDef = {
  description:
    "加入（或修改）EasyTier 私有网络。写配置、启动或重启 EasyTier 核心，最多等 40 秒。" +
    '成功返回 {state:"online"}；仍在启动返回 {state:"starting"}，用 status 轮询；失败抛 E_NETWORK_TIMEOUT。',
  args: {
    type: "object",
    properties: {
      networkName: { type: "string", description: "EasyTier 网络名" },
      networkSecret: { type: "string", description: "EasyTier 网络密码（唯一入网门）" },
      initialNode: {
        type: "string",
        description: "可选的初始节点，如 tcp://host:11010；多个用逗号分隔",
      },
    },
    required: ["networkName", "networkSecret"],
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const name = requiredString(args, "networkName", 128, "networkName");
    const secret = requiredString(args, "networkSecret", 512, "networkSecret");
    const initialNode = optionalString(args, "initialNode", 2048, "initialNode") ?? null;

    const network: NetworkConfig = { name, secret, initialNode };
    const runtime = await getRuntime();
    const next = { ...runtime.config, network };
    try {
      writeConfig(next);
    } catch (error) {
      fail("E_PATH", `cannot write state.json: ${error instanceof Error ? error.message : String(error)}`);
    }
    runtime.config = next;

    // beginStart is inside join: a second call supersedes the first instead of
    // spawning two cores. Timeout leaves the work running for status to report.
    const state = await runtime.overlay.join(next, 40_000);
    return jsonText({ state });
  },
};
