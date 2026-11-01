// status: the one read-only snapshot an agent needs to know where the node is.

import { getRuntime } from "../runtime.ts";
import { walletBalances } from "./node-wallet.ts";
import { fail, jsonText, objectArgs, type ToolDef } from "./types.ts";

const SECTIONS = ["network", "wallet", "sharing", "consuming"] as const;

export const statusTool: ToolDef = {
  description:
    "节点状态快照。network: 网络/覆盖网地址/邻居/公布端口；wallet: 地址与 BSC/Base 余额；" +
    "sharing: 节点地址、已公布的模型与目录时间戳、消费者；consuming: 申请与连接（后续阶段）。" +
    "不传 section 返回全部。",
  args: {
    type: "object",
    properties: {
      section: {
        type: "string",
        enum: [...SECTIONS],
        description: "只返回该部分；省略时返回 network、wallet、sharing、consuming",
      },
    },
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const section = args.section === null ? undefined : args.section;
    if (section !== undefined && (typeof section !== "string" || !(SECTIONS as readonly string[]).includes(section))) {
      fail("E_INPUT", `section must be one of ${SECTIONS.join(", ")}`);
    }

    const runtime = await getRuntime();
    const catalog = runtime.catalog.status();
    const network = runtime.overlay.status();
    // A directory that cannot bind is not a network state of its own, but it must
    // be visible somewhere: `detail` is the field an agent already reads.
    if (catalog.detail) {
      network.detail = network.detail ? `${network.detail}; directory: ${catalog.detail}` : `directory: ${catalog.detail}`;
    }
    const wallet = async () => walletBalances(runtime.wallet.address);
    const sharing = () => {
      const doc = runtime.catalog.current;
      return {
        address: runtime.wallet.address,
        models: doc?.models ?? [],
        catalogTs: doc?.ts ?? null,
        consumers: [] as unknown[],
      };
    };
    const consuming = () => ({ requests: [] as unknown[], connections: [] as unknown[] });

    if (section === "network") return jsonText(network);
    if (section === "wallet") return jsonText(await wallet());
    if (section === "sharing") return jsonText(sharing());
    if (section === "consuming") return jsonText(consuming());

    return jsonText({
      network,
      wallet: await wallet(),
      sharing: sharing(),
      consuming: consuming(),
    });
  },
};
