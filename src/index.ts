#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { ConnectionPool } from "./pool.js";
import {
  discoverAll,
  saveCatalogCache,
  loadCatalogCache,
  type ToolCatalogEntry,
} from "./discovery.js";
import { resolve } from "node:path";
import { homedir } from "node:os";

const CACHE_PATH = resolve(
  homedir(),
  ".cache",
  "mcp-multiplexer",
  "catalog.json"
);

async function main() {
  const config = loadConfig();
  process.stderr.write(
    `[mcp-mux] loaded ${config.servers.length} server configs\n`
  );
  process.stderr.write(
    `[mcp-mux] pool: max ${config.maxConcurrent} concurrent, ${config.idleTimeoutMs / 1000}s idle timeout\n`
  );

  // Step 1: Discover tool catalog (use cache if fresh, otherwise probe all servers)
  let catalog: Map<string, ToolCatalogEntry>;
  let serverTools: Map<string, string[]>;
  let serverConfigs = new Map(config.servers.map((s) => [s.name, s]));

  const useCache = process.env.MCP_MUX_NO_CACHE !== "1";
  const cached = useCache ? loadCatalogCache(CACHE_PATH) : null;

  if (cached) {
    catalog = cached.catalog;
    serverTools = cached.serverTools;
    process.stderr.write(
      `[mcp-mux] loaded ${catalog.size} tools from cache\n`
    );
  } else {
    process.stderr.write(
      `[mcp-mux] discovering tools from ${config.servers.length} servers (this may take a minute)...\n`
    );
    const discovered = await discoverAll(
      config.servers,
      config.discoveryTimeoutMs,
      5
    );
    catalog = discovered.catalog;
    serverTools = discovered.serverTools;

    if (catalog.size > 0) {
      saveCatalogCache(catalog, serverTools, CACHE_PATH);
      process.stderr.write(
        `[mcp-mux] cached ${catalog.size} tools from ${serverTools.size} servers\n`
      );
    }
  }

  process.stderr.write(
    `[mcp-mux] ready: ${catalog.size} tools from ${serverTools.size} servers\n`
  );

  // Step 2: Create the connection pool (lazy — no servers running yet)
  const pool = new ConnectionPool(
    config.maxConcurrent,
    config.idleTimeoutMs
  );

  // Step 3: Create MCP server that presents all tools natively
  const server = new Server(
    { name: "mcp-multiplexer", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List all discovered tools as if they belong to this server
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [...catalog.values()].map((entry) => entry.tool),
    };
  });

  // Route tool calls to the correct backend, spawning on demand
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const entry = catalog.get(toolName);

    if (!entry) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Unknown tool: ${toolName}`,
          },
        ],
        isError: true,
      };
    }

    const serverConfig = serverConfigs.get(entry.serverName);
    if (!serverConfig) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Server config not found for: ${entry.serverName}`,
          },
        ],
        isError: true,
      };
    }

    // Lazy-spawn the backend and forward the call
    try {
      const client = await pool.acquire(serverConfig);

      // The original tool name might have been prefixed for collision avoidance.
      // Send the original name to the backend.
      const originalName = entry.tool.name.includes("__")
        ? entry.tool.name.split("__").slice(1).join("__")
        : entry.tool.name;

      const result = await client.callTool({
        name: originalName,
        arguments: request.params.arguments ?? {},
      });

      return result as {
        content: Array<{ type: "text"; text: string }>;
        isError?: boolean;
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[mcp-mux] call failed for ${toolName} on ${entry.serverName}: ${msg}\n`
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Tool call failed (${entry.serverName}/${toolName}): ${msg}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Graceful shutdown
  process.on("SIGINT", async () => {
    process.stderr.write("[mcp-mux] shutting down...\n");
    await pool.shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    process.stderr.write("[mcp-mux] shutting down...\n");
    await pool.shutdown();
    process.exit(0);
  });

  // Step 4: Connect to Claude Code via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp-mux] connected to client via stdio\n");
}

main().catch((err) => {
  process.stderr.write(`[mcp-mux] fatal: ${err}\n`);
  process.exit(1);
});
