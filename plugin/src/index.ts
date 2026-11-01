// Magpie community plugin entry.
//
// Magpie imports this file and awaits the default export while loading plugins,
// then collects the returned `tool` record. Boot must therefore return
// synchronously: the real work (config, wallet, optional EasyTier start) runs in
// `boot()` in the background, and every tool awaits the same runtime promise.
//
// There is no console, no local HTTP API, no CLI and no page-side JavaScript.
// The only interaction surface is the MCP tools Magpie exposes to agents.

import { logger } from "./log.ts";
import { boot } from "./runtime.ts";
import { TOOLS } from "./tools/index.ts";

export default function plugin(_input?: unknown, _options?: unknown): {
  tool: typeof TOOLS;
} {
  void boot().catch((error) => {
    logger.error(`plugin bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return { tool: TOOLS };
}

export { boot };
