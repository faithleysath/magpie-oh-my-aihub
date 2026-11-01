// wallet_import: replace the node identity from a 32-byte hex private key file.

import { getRuntime, replaceWallet } from "../runtime.ts";
import { importWallet } from "./node-wallet.ts";
import { fail, jsonText, objectArgs, optionalBoolean, requiredString, type ToolDef } from "./types.ts";

export const walletImportTool: ToolDef = {
  description:
    "从绝对路径的 32 字节 hex 私钥文件导入节点钱包。已有钱包且地址不同时默认拒绝，除非 force:true。" +
    "返回地址和是否发生了变更，不返回私钥。",
  args: {
    type: "object",
    properties: {
      path: { type: "string", description: "私钥文件的绝对路径（内容为 32 字节 hex，可带 0x）" },
      force: { type: "boolean", description: "已有不同地址的钱包时仍然替换；默认 false" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const path = requiredString(args, "path", 4096, "path");
    const force = optionalBoolean(args, "force");

    const runtime = await getRuntime();
    let result;
    try {
      result = importWallet(path, force);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Keep coded errors intact; wrap filesystem surprises in E_PATH.
      if (/^E_[A-Z_]+:/.test(message)) throw error;
      fail("E_PATH", message);
    }
    if (result.changed) replaceWallet(runtime, result.wallet);
    return jsonText({ address: result.address, changed: result.changed });
  },
};
