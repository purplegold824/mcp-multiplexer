#!/usr/bin/env node

// Standalone tool: discovers all tools from configured servers and saves the cache.
// Usage: npx tsx src/discover-cli.ts

import { loadConfig } from "./config.js";
import { discoverAll, saveCatalogCache } from "./discovery.js";
import { resolve } from "node:path";
import { homedir } from "node:os";

const CACHE_PATH = resolve(homedir(), ".cache", "mcp-multiplexer", "catalog.json");

async function main() {
  const config = loadConfig();
  console.log(`Loaded ${config.servers.length} server configs`);
  console.log(`Discovery timeout: ${config.discoveryTimeoutMs}ms per server`);

  const { catalog, serverTools } = await discoverAll(
    config.servers,
    config.discoveryTimeoutMs,
    5
  );

  console.log(`\nDiscovered ${catalog.size} tools from ${serverTools.size} servers`);

  if (catalog.size > 0) {
    saveCatalogCache(catalog, serverTools, CACHE_PATH);
    console.log(`Cache saved to ${CACHE_PATH}`);
  }

  // Print summary
  for (const [server, tools] of serverTools) {
    console.log(`  ${server}: ${tools.length} tools`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
