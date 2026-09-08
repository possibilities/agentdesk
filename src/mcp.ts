/** Stdio lifecycle for `agentdesk mcp`. Stdout belongs exclusively to MCP. */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type CreateAgentdeskMcpServerOptions, createAgentdeskMcpServer } from "./mcp-server.ts";

export async function serveAgentdeskMcp(
  options: CreateAgentdeskMcpServerOptions = {},
): Promise<void> {
  const { server, appServer } = createAgentdeskMcpServer(options);
  const transport = new StdioServerTransport();
  let closeResolve: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  const priorClose = server.onclose;
  server.onclose = () => {
    priorClose?.();
    closeResolve?.();
  };
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.close().catch(() => closeResolve?.());
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);

  try {
    await server.connect(transport);
    await closed;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.stdin.off("end", stop);
    process.stdin.off("close", stop);
    await server.close().catch(() => undefined);
    await appServer.close();
  }
}
