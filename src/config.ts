import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export interface ServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface MultiplexerConfig {
  servers: ServerConfig[];
  maxConcurrent: number;
  idleTimeoutMs: number;
  discoveryTimeoutMs: number;
  callTimeoutMs: number;
}

interface RawServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
}

function parseServersFromFile(filePath: string): ServerConfig[] {
  if (!existsSync(filePath)) return [];
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  const mcpServers: Record<string, RawServerEntry> =
    raw.mcpServers ?? raw;
  return Object.entries(mcpServers).map(([name, entry]) => ({
    name,
    command: entry.command,
    args: entry.args ?? [],
    env: entry.env ?? {},
  }));
}

export function loadConfig(): MultiplexerConfig {
  const home = homedir();
  const configDir = resolve(home, ".claude", "mcp-configs");
  const mainConfig = resolve(home, ".claude.json");

  // Determine which sources to load:
  // MCP_MUX_CONFIGS env var (comma-separated file paths or profile names)
  // Default: read all profiles from ~/.claude/mcp-configs/
  const configSources = process.env.MCP_MUX_CONFIGS;

  let servers: ServerConfig[] = [];
  const seen = new Set<string>();

  if (configSources) {
    for (const source of configSources.split(",").map((s) => s.trim())) {
      const filePath = existsSync(source)
        ? source
        : resolve(configDir, `${source}.json`);
      for (const s of parseServersFromFile(filePath)) {
        if (!seen.has(s.name)) {
          seen.add(s.name);
          servers.push(s);
        }
      }
    }
  } else {
    // Load from main ~/.claude.json first
    for (const s of parseServersFromFile(mainConfig)) {
      if (!seen.has(s.name)) {
        seen.add(s.name);
        servers.push(s);
      }
    }
    // Then load all profiles
    if (existsSync(configDir)) {
      const profileFiles = [
        "aws.json",
        "comms.json",
        "extras.json",
      ];
      for (const file of profileFiles) {
        for (const s of parseServersFromFile(resolve(configDir, file))) {
          if (!seen.has(s.name)) {
            seen.add(s.name);
            servers.push(s);
          }
        }
      }
    }
  }

  // Filter out the multiplexer itself to avoid recursion
  servers = servers.filter((s) => s.name !== "mcp-multiplexer");

  return {
    servers,
    maxConcurrent: parseInt(process.env.MCP_MUX_MAX_CONCURRENT ?? "20", 10),
    idleTimeoutMs: parseInt(
      process.env.MCP_MUX_IDLE_TIMEOUT_MS ?? "300000",
      10
    ), // 5 min
    discoveryTimeoutMs: parseInt(
      process.env.MCP_MUX_DISCOVERY_TIMEOUT_MS ?? "15000",
      10
    ), // 15s
    callTimeoutMs: parseInt(
      process.env.MCP_MUX_CALL_TIMEOUT_MS ?? "120000",
      10
    ), // 2 min
  };
}
