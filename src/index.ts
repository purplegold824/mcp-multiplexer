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

  // Step 3: Create MCP server with meta-tools (search + call + list_servers)
  // Instead of exposing all 860+ tools directly (which would consume ~360K tokens),
  // we expose 3 meta-tools that let Claude search and call any tool on demand.
  const server = new Server(
    { name: "mcp-multiplexer", version: "2.0.0" },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Build a simple search index: tool name + description, keyed by tool name
  const searchIndex: Array<{
    name: string;
    description: string;
    serverName: string;
  }> = [];
  for (const [name, entry] of catalog) {
    searchIndex.push({
      name,
      description: entry.tool.description ?? "",
      serverName: entry.serverName,
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "mux_search_tools",
          description:
            "Search the MCP tool catalog. Returns matching tool names, descriptions, and their server. " +
            "Use this to find the right tool before calling it with mux_call_tool. " +
            `There are ${catalog.size} tools available from ${serverTools.size} servers.`,
          inputSchema: {
            type: "object" as const,
            properties: {
              query: {
                type: "string",
                description:
                  "Search query — matches against tool names and descriptions. " +
                  "Examples: 'create issue', 'terraform', 'gitlab merge request', 'jira transition'",
              },
              server: {
                type: "string",
                description:
                  "Optional: filter results to a specific server name. Use mux_list_servers to see available servers.",
              },
              limit: {
                type: "number",
                description: "Max results to return (default: 20)",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "mux_call_tool",
          description:
            "Call any tool from the MCP catalog by name. The tool is routed to the correct backend server, " +
            "which is lazily spawned on first use. Use mux_search_tools first to find the tool name and see its schema.",
          inputSchema: {
            type: "object" as const,
            properties: {
              tool_name: {
                type: "string",
                description: "The exact tool name from the catalog (as returned by mux_search_tools)",
              },
              arguments: {
                type: "object",
                description: "Arguments to pass to the tool (must match the tool's input schema)",
                additionalProperties: true,
              },
            },
            required: ["tool_name"],
          },
        },
        {
          name: "mux_list_servers",
          description:
            "List all available MCP servers and how many tools each provides. " +
            "Use this to understand what's available before searching for specific tools.",
          inputSchema: {
            type: "object" as const,
            properties: {},
          },
        },
        {
          name: "mux_tool_schema",
          description:
            "Get the full JSON schema for a specific tool. Use after mux_search_tools to see " +
            "the exact parameters a tool accepts before calling it with mux_call_tool.",
          inputSchema: {
            type: "object" as const,
            properties: {
              tool_name: {
                type: "string",
                description: "The exact tool name from the catalog",
              },
            },
            required: ["tool_name"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const metaTool = request.params.name;
    const args = request.params.arguments ?? {};

    // --- mux_search_tools ---
    if (metaTool === "mux_search_tools") {
      const query = (args.query as string ?? "").toLowerCase();
      const serverFilter = args.server as string | undefined;
      const limit = (args.limit as number) ?? 20;

      const results = searchIndex
        .filter((entry) => {
          if (serverFilter && entry.serverName !== serverFilter) return false;
          const haystack = `${entry.name} ${entry.description}`.toLowerCase();
          // All query terms must match
          return query.split(/\s+/).every((term) => haystack.includes(term));
        })
        .slice(0, limit)
        .map((entry) => ({
          tool_name: entry.name,
          server: entry.serverName,
          description:
            entry.description.length > 200
              ? entry.description.slice(0, 200) + "..."
              : entry.description,
        }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query,
                server_filter: serverFilter ?? null,
                result_count: results.length,
                results,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // --- mux_list_servers ---
    if (metaTool === "mux_list_servers") {
      const servers = [...serverTools.entries()].map(([name, tools]) => ({
        server: name,
        tool_count: tools.length,
      }));
      servers.sort((a, b) => b.tool_count - a.tool_count);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                total_servers: servers.length,
                total_tools: catalog.size,
                servers,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // --- mux_tool_schema ---
    if (metaTool === "mux_tool_schema") {
      const toolName = args.tool_name as string;
      const entry = catalog.get(toolName);
      if (!entry) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown tool: ${toolName}. Use mux_search_tools to find available tools.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                tool_name: toolName,
                server: entry.serverName,
                description: entry.tool.description,
                input_schema: entry.tool.inputSchema,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // --- mux_call_tool ---
    if (metaTool === "mux_call_tool") {
      const toolName = args.tool_name as string;
      const toolArgs = (args.arguments as Record<string, unknown>) ?? {};

      const entry = catalog.get(toolName);
      if (!entry) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown tool: ${toolName}. Use mux_search_tools to find available tools.`,
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

      try {
        const client = await pool.acquire(serverConfig);

        // The original tool name might have been prefixed for collision avoidance.
        const originalName = entry.tool.name.includes("__")
          ? entry.tool.name.split("__").slice(1).join("__")
          : entry.tool.name;

        const result = await client.callTool({
          name: originalName,
          arguments: toolArgs,
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
    }

    // Unknown meta-tool
    return {
      content: [
        {
          type: "text" as const,
          text: `Unknown multiplexer command: ${metaTool}. Available: mux_search_tools, mux_call_tool, mux_list_servers, mux_tool_schema`,
        },
      ],
      isError: true,
    };
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
