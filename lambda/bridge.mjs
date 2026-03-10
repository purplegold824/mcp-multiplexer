// Generic MCP Bridge Lambda
// Spawns any MCP server as a subprocess, calls one tool, returns the result.
// Input: { serverCommand, serverArgs, serverEnv, toolName, toolArguments }
// Output: { content, isError }

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function handler(event) {
  const {
    serverCommand,
    serverArgs = [],
    serverEnv = {},
    toolName,
    toolArguments = {},
    action = "call_tool", // "call_tool" or "list_tools"
  } = event;

  if (!serverCommand) {
    return { content: [{ type: "text", text: "Missing serverCommand" }], isError: true };
  }

  let client;
  try {
    const transport = new StdioClientTransport({
      command: serverCommand,
      args: serverArgs,
      env: { ...process.env, ...serverEnv },
    });

    client = new Client(
      { name: "mcp-mux-lambda-bridge", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);

    if (action === "list_tools") {
      const result = await client.listTools();
      await client.close();
      return { tools: result.tools ?? [], isError: false };
    }

    if (!toolName) {
      await client.close();
      return { content: [{ type: "text", text: "Missing toolName" }], isError: true };
    }

    const result = await client.callTool({
      name: toolName,
      arguments: toolArguments,
    });

    await client.close();
    return result;
  } catch (err) {
    try { await client?.close(); } catch {}
    return {
      content: [{ type: "text", text: `Bridge error: ${err.message}` }],
      isError: true,
    };
  }
}
