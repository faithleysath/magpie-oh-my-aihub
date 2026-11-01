import type { ToolDef } from "./types.ts";
import { connectTool, connectionsTool, disconnectTool, requestAccessTool } from "./consumer.ts";
import { approveRequestTool, consumersTool, rejectRequestTool, revokeConsumerTool } from "./consumers.ts";
import { discoverTool } from "./discover.ts";
import { joinNetworkTool } from "./join-network.ts";
import { historyTool, sendPaymentTool } from "./money.ts";
import { contactsTool } from "./contacts.ts";
import { nativeModelsTool } from "./native-models.ts";
import { shareModelsTool } from "./share-models.ts";
import { statusTool } from "./status.ts";
import { walletExportTool } from "./wallet-export.ts";
import { walletImportTool } from "./wallet-import.ts";
import { walletTool } from "./wallet.ts";

/**
 * The 19 tools. Magpie prefixes each name with the plugin's short name (the
 * package name without its scope: `magpie-plugin`), so these become
 * `magpie-plugin_status`, `..._wallet`, and so on.
 *
 * Provider side: consumers, approve_request, reject_request, revoke_consumer.
 * Consumer side: discover, request_access, connect_provider,
 * disconnect_provider, connections.
 * Money: send_payment (out and in: a consumer pays a provider with the same
 * tool) and history (local deposits plus payouts).
 * Local convenience: contacts (the alias → address book that every tool taking a
 * counterparty address resolves against).
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
  request_access: requestAccessTool,
  connect_provider: connectTool,
  disconnect_provider: disconnectTool,
  connections: connectionsTool,
  consumers: consumersTool,
  approve_request: approveRequestTool,
  reject_request: rejectRequestTool,
  revoke_consumer: revokeConsumerTool,
  send_payment: sendPaymentTool,
  history: historyTool,
  contacts: contactsTool,
};
