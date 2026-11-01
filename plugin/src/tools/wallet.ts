// wallet: address plus read-only balances. Never returns the private key.

import { getRuntime } from "../runtime.ts";
import { walletBalances } from "./node-wallet.ts";
import { jsonText, NO_ARGS, type ToolDef } from "./types.ts";

export const walletTool: ToolDef = {
  description:
    "节点钱包地址，以及 BSC(56) / Base(8453) 上的 USDC 和原生币余额。只读；RPC 失败会返回该链 " +
    'status:"unavailable"，不会让整个调用失败。',
  args: NO_ARGS,
  async execute() {
    const runtime = await getRuntime();
    return jsonText(await walletBalances(runtime.wallet.address));
  },
};
