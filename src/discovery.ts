import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "./config.js";

export interface ToolCatalogEntry {
  tool: Tool;
  serverName: string;
}

// Discover tools from a single server by briefly connecting, listing tools, then disconnecting.
async function discoverServer(
  config: ServerConfig,
  timeoutMs: number
): Promise<ToolCatalogEntry[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>,
    });

    const client = new Client(
      { name: `mcp-mux-discover-${config.name}`, version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);

    const result = await client.listTools();
    const entries: ToolCatalogEntry[] = (result.tools ?? []).map((tool) => ({
      tool,
      serverName: config.name,
    }));

    await client.close();
    return entries;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[mcp-mux] discovery failed for ${config.name}: ${msg}\n`
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Discover tools from all servers. Runs in parallel with concurrency limit.
export async function discoverAll(
  servers: ServerConfig[],
  timeoutMs: number,
  concurrency: number = 5
): Promise<{
  catalog: Map<string, ToolCatalogEntry>;
  serverTools: Map<string, string[]>;
}> {
  const catalog = new Map<string, ToolCatalogEntry>();
  const serverTools = new Map<string, string[]>();

  // Process in batches to avoid spawning 74 processes at once
  for (let i = 0; i < servers.length; i += concurrency) {
    const batch = servers.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((s) => discoverServer(s, timeoutMs))
    );

    for (let j = 0; j < results.length; j++) {
      const server = batch[j];
      const result = results[j];

      if (result.status === "fulfilled" && result.value.length > 0) {
        const toolNames: string[] = [];
        for (const entry of result.value) {
          // Handle name collisions — prefix with server name
          const toolName = catalog.has(entry.tool.name)
            ? `${server.name}__${entry.tool.name}`
            : entry.tool.name;

          catalog.set(toolName, {
            tool: { ...entry.tool, name: toolName },
            serverName: server.name,
          });
          toolNames.push(toolName);
        }
        serverTools.set(server.name, toolNames);
        process.stderr.write(
          `[mcp-mux] discovered ${result.value.length} tools from ${server.name}\n`
        );
      } else if (result.status === "rejected") {
        process.stderr.write(
          `[mcp-mux] discovery error for ${server.name}: ${result.reason}\n`
        );
      }
    }
  }

  return { catalog, serverTools };
}

// Cache the catalog to disk for fast startup next time
export function saveCatalogCache(
  catalog: Map<string, ToolCatalogEntry>,
  serverTools: Map<string, string[]>,
  cachePath: string
): void {
  // Using top-level imports (ESM)
  const data = {
    version: 1,
    timestamp: new Date().toISOString(),
    catalog: Object.fromEntries(catalog),
    serverTools: Object.fromEntries(serverTools),
  };
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(data, null, 2));
}

export function loadCatalogCache(
  cachePath: string,
  maxAgeMs: number = 3600_000 // 1 hour
): {
  catalog: Map<string, ToolCatalogEntry>;
  serverTools: Map<string, string[]>;
} | null {
  if (!existsSync(cachePath)) return null;

  const stat = statSync(cachePath);
  if (Date.now() - stat.mtimeMs > maxAgeMs) return null;

  try {
    const data = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (data.version !== 1) return null;
    return {
      catalog: new Map(Object.entries(data.catalog)),
      serverTools: new Map(Object.entries(data.serverTools)),
    };
  } catch {
    return null;
  }
}
