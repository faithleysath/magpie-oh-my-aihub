import type { ToolDef } from "./types.ts";
import { joinNetworkTool } from "./join-network.ts";
import { statusTool } from "./status.ts";
import { walletExportTool } from "./wallet-export.ts";
import { walletImportTool } from "./wallet-import.ts";
import { walletTool } from "./wallet.ts";

/**
 * Stage 1 tools. Magpie prefixes each name with the plugin's short name, so
 * these become `magpie-oh-my-aihub_status`, `..._wallet`, and so on.
 */
export const TOOLS: Record<string, ToolDef> = {
  status: statusTool,
  wallet: walletTool,
  wallet_import: walletImportTool,
  wallet_export: walletExportTool,
  join_network: joinNetworkTool,
};
