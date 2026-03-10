import { ChildProcess, spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ServerConfig } from "./config.js";

export interface PoolEntry {
  name: string;
  config: ServerConfig;
  client: Client;
  transport: StdioClientTransport;
  process: ChildProcess | null;
  lastUsed: number;
  connecting: boolean;
}

export interface SpawnAdapter {
  spawn(config: ServerConfig): Promise<{ client: Client; transport: StdioClientTransport; process: ChildProcess | null }>;
  kill(entry: PoolEntry): Promise<void>;
}

// Default local adapter — spawns subprocess via stdio
export class LocalSpawnAdapter implements SpawnAdapter {
  async spawn(config: ServerConfig): Promise<{ client: Client; transport: StdioClientTransport; process: ChildProcess | null }> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>,
    });

    const client = new Client(
      { name: `mcp-mux-${config.name}`, version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    const proc = (transport as any)._process ?? null;
    return { client, transport, process: proc };
  }

  async kill(entry: PoolEntry): Promise<void> {
    try {
      await entry.client.close();
    } catch {
      // Best effort
    }
    if (entry.process && !entry.process.killed) {
      entry.process.kill("SIGTERM");
      setTimeout(() => {
        if (entry.process && !entry.process.killed) {
          entry.process.kill("SIGKILL");
        }
      }, 3000);
    }
  }
}

export class ConnectionPool {
  private active = new Map<string, PoolEntry>();
  private pending = new Map<string, Promise<PoolEntry>>();
  private maxConcurrent: number;
  private idleTimeoutMs: number;
  private reapInterval: ReturnType<typeof setInterval> | null = null;
  private adapter: SpawnAdapter;

  constructor(
    maxConcurrent: number,
    idleTimeoutMs: number,
    adapter?: SpawnAdapter
  ) {
    this.maxConcurrent = maxConcurrent;
    this.idleTimeoutMs = idleTimeoutMs;
    this.adapter = adapter ?? new LocalSpawnAdapter();
    this.reapInterval = setInterval(() => this.reapIdle(), 30_000);
  }

  async acquire(config: ServerConfig): Promise<Client> {
    // Return existing connection
    const existing = this.active.get(config.name);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.client;
    }

    // Join pending connection if someone else is already connecting
    const pendingConn = this.pending.get(config.name);
    if (pendingConn) {
      const entry = await pendingConn;
      entry.lastUsed = Date.now();
      return entry.client;
    }

    // Evict LRU if at capacity
    if (this.active.size >= this.maxConcurrent) {
      await this.evictLRU();
    }

    // Spawn new connection
    const connectPromise = this.connect(config);
    this.pending.set(config.name, connectPromise);

    try {
      const entry = await connectPromise;
      this.active.set(config.name, entry);
      return entry.client;
    } finally {
      this.pending.delete(config.name);
    }
  }

  private async connect(config: ServerConfig): Promise<PoolEntry> {
    const { client, transport, process: proc } = await this.adapter.spawn(config);

    return {
      name: config.name,
      config,
      client,
      transport,
      process: proc,
      lastUsed: Date.now(),
      connecting: false,
    };
  }

  private async evictLRU(): Promise<void> {
    let oldest: PoolEntry | null = null;
    for (const entry of this.active.values()) {
      if (!oldest || entry.lastUsed < oldest.lastUsed) {
        oldest = entry;
      }
    }
    if (oldest) {
      await this.evict(oldest.name);
    }
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    const toEvict: string[] = [];
    for (const [name, entry] of this.active) {
      if (now - entry.lastUsed > this.idleTimeoutMs) {
        toEvict.push(name);
      }
    }
    for (const name of toEvict) {
      await this.evict(name);
    }
  }

  private async evict(name: string): Promise<void> {
    const entry = this.active.get(name);
    if (!entry) return;
    this.active.delete(name);
    await this.adapter.kill(entry);
    process.stderr.write(
      `[mcp-mux] evicted idle server: ${name} (was idle ${Math.round((Date.now() - entry.lastUsed) / 1000)}s)\n`
    );
  }

  get stats(): { active: number; names: string[] } {
    return {
      active: this.active.size,
      names: [...this.active.keys()],
    };
  }

  async shutdown(): Promise<void> {
    if (this.reapInterval) clearInterval(this.reapInterval);
    const kills = [...this.active.values()].map((e) => this.adapter.kill(e));
    await Promise.allSettled(kills);
    this.active.clear();
  }
}
