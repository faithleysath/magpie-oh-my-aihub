// join_network: write the v3 config, then start or restart the overlay.

import { writeConfig, type NetworkConfig } from "../config.ts";
import { getRuntime } from "../runtime.ts";
import { fail, jsonText, objectArgs, optionalBoolean, optionalString, requiredString, type ToolDef } from "./types.ts";

export const joinNetworkTool: ToolDef = {
  description:
    "加入（或修改）EasyTier 私有网络。写配置、启动或重启 EasyTier 核心，最多等 40 秒。" +
    '成功返回 {state:"online"}；仍在启动返回 {state:"starting"}，用 status 轮询；失败抛 E_NETWORK_TIMEOUT。' +
    "网络开了 secure mode 时要传 secureMode:true：那样的网络会拒掉没开的节点（peers 永远是空的）。" +
    "本机密钥自动生成并保存，不需要和别人交换任何密钥。same network 重新 join 时省略 secureMode/listen 会沿用上次的值。" +
    "想要直连（不走种子中继）就传 listen:true，并在主机防火墙放行 11010 的 tcp 与 udp。",
  args: {
    type: "object",
    properties: {
      networkName: { type: "string", description: "EasyTier 网络名" },
      networkSecret: { type: "string", description: "EasyTier 网络密码（入网门）" },
      initialNode: {
        type: "string",
        description: "可选的初始节点，如 tcp://host:11010；多个用逗号分隔",
      },
      secureMode: {
        type: "boolean",
        description:
          "网络是否启用了 EasyTier secure mode。开了的网会拒掉没开的节点（同网节点必须一致）；" +
          "开启后本机会自动生成并复用一对 X25519 密钥，不需要和网络里任何人交换密钥",
      },
      listen: {
        type: "boolean",
        description:
          "是否在本机开 EasyTier 监听（tcp+udp 11010），让别人能直连你，而不是所有流量都走种子中继。" +
          "只在入站端口真的可达时开（有公网地址、或路由器把端口转给了你），而且要在主机防火墙上放行 11010 的 tcp 和 udp；" +
          "开了却不可达比不开更糟：别的节点会尝试直连你然后回退到中继",
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

    const runtime = await getRuntime();
    const previous = runtime.config.network;
    const explicit = args.secureMode !== undefined && args.secureMode !== null;
    // Re-joining the same network inherits the flag: forgetting it would drop a
    // working secure-mode node out of an overlay that requires it, and the only
    // symptom would be an empty peer list.
    const secureMode = explicit
      ? optionalBoolean(args, "secureMode")
      : previous?.name === name
        ? previous.secureMode
        : false;
    const listenExplicit = args.listen !== undefined && args.listen !== null;
    const listen = listenExplicit
      ? optionalBoolean(args, "listen")
      : previous?.name === name
        ? previous.listen
        : false;

    const network: NetworkConfig = { name, secret, initialNode, secureMode, listen };
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
