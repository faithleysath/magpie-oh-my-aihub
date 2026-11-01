import type { ToolDef } from "./types.ts";
import { discoverTool } from "./discover.ts";
import { joinNetworkTool } from "./join-network.ts";
import { nativeModelsTool } from "./native-models.ts";
import { shareModelsTool } from "./share-models.ts";
import { statusTool } from "./status.ts";
import { walletExportTool } from "./wallet-export.ts";
import { walletImportTool } from "./wallet-import.ts";
import { walletTool } from "./wallet.ts";

/**
 * The stage-2 tools. Magpie prefixes each name with the plugin's short name, so
 * these become `magpie-oh-my-aihub_status`, `..._wallet`, and so on.
 */
export const TOOLS: Record<string, ToolDef> = {
  status: statusTool,
  wallet: walletTool,
  wallet_import: walletImportTool,
  wallet_export: walletExportTool,
  join_network: joinNetworkTool,
  native_models: nativeModelsTool,
  share_models: shareModelsTool,
  discover: discoverTool,
};
