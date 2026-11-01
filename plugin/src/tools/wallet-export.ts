// wallet_export: write the key to a user-chosen file, never to the data dir.

import { exportWallet } from "./node-wallet.ts";
import { fail, jsonText, objectArgs, optionalBoolean, requiredString, type ToolDef } from "./types.ts";

export const walletExportTool: ToolDef = {
  description:
    "把节点私钥导出到指定的绝对路径（文件权限 0600）。目标已存在时需要 overwrite:true；" +
    "拒绝写进插件数据目录。返回地址和路径，不返回私钥。",
  args: {
    type: "object",
    properties: {
      path: { type: "string", description: "导出的绝对路径" },
      overwrite: { type: "boolean", description: "目标文件已存在时覆盖；默认 false" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const path = requiredString(args, "path", 4096, "path");
    const overwrite = optionalBoolean(args, "overwrite");

    let result;
    try {
      result = exportWallet(path, overwrite);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/^E_[A-Z_]+:/.test(message)) throw error;
      fail("E_PATH", message);
    }
    return jsonText({ address: result.address, path: result.path });
  },
};
