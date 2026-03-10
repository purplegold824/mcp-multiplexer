import {
  LambdaClient,
  InvokeCommand,
} from "@aws-sdk/client-lambda";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ServerConfig } from "./config.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface LambdaAdapterConfig {
  functionName: string;
  region: string;
  profile?: string;
}

// A thin client that routes tool calls through the Lambda bridge
// instead of maintaining a persistent subprocess connection.
export class LambdaToolClient {
  private lambda: LambdaClient;
  private functionName: string;
  private serverConfig: ServerConfig;

  constructor(
    lambdaConfig: LambdaAdapterConfig,
    serverConfig: ServerConfig
  ) {
    this.lambda = new LambdaClient({
      region: lambdaConfig.region,
      ...(lambdaConfig.profile && {
        credentials: undefined, // uses profile from env
      }),
    });
    this.functionName = lambdaConfig.functionName;
    this.serverConfig = serverConfig;
  }

  async callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const payload = {
      serverCommand: this.serverConfig.command,
      serverArgs: this.serverConfig.args,
      serverEnv: this.serverConfig.env,
      toolName: params.name,
      toolArguments: params.arguments,
      action: "call_tool",
    };

    const command = new InvokeCommand({
      FunctionName: this.functionName,
      Payload: encoder.encode(JSON.stringify(payload)),
    });

    const response = await this.lambda.send(command);

    if (response.FunctionError) {
      const errorBody = decoder.decode(response.Payload);
      return {
        content: [
          { type: "text", text: `Lambda error: ${errorBody}` },
        ],
        isError: true,
      };
    }

    const result = JSON.parse(decoder.decode(response.Payload));
    return result;
  }

  async listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: unknown }> }> {
    const payload = {
      serverCommand: this.serverConfig.command,
      serverArgs: this.serverConfig.args,
      serverEnv: this.serverConfig.env,
      action: "list_tools",
    };

    const command = new InvokeCommand({
      FunctionName: this.functionName,
      Payload: encoder.encode(JSON.stringify(payload)),
    });

    const response = await this.lambda.send(command);
    const result = JSON.parse(decoder.decode(response.Payload));
    return result;
  }

  async close(): Promise<void> {
    this.lambda.destroy();
  }
}
