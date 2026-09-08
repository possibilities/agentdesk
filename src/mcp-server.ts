/**
 * Agentdesk's MCP protocol surface.
 *
 * This uses the low-level SDK server deliberately: the Computer Use tools are
 * discovered from Codex and already carry JSON Schema. Passing those schemas
 * through unchanged avoids translating them to Zod and back (and losing
 * annotations or future schema keywords along the way).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ElicitResultSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexElicitationRequest,
  type CodexElicitationResponse,
  type CodexTool,
  type CodexToolResult,
} from "./codex-app-server.ts";
import { CONTRACT, guideEnvelope, renderAgentHelp } from "./contract.ts";

const COMPUTER_USE_TOOLS = new Set(["js", "js_reset"]);
const RECOVERY = CONTRACT.concepts.error_codes.find(
  (entry) => entry.code === "computer_use_failed",
)?.recovery;

const GUIDE_TOOL: Tool = {
  name: "guide",
  title: "Agentdesk guide",
  description:
    "Return Agentdesk's version-1 agent contract. Use this when the host did not forward the server instructions.",
  inputSchema: {
    type: "object",
    properties: {
      json: {
        type: "boolean",
        description: "Accepted for CLI parity; MCP output is always structured JSON.",
      },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export interface AgentdeskAppServer {
  listTools(): Promise<readonly CodexTool[]>;
  callTool(
    name: string,
    args?: unknown,
    options?: {
      readonly signal?: AbortSignal;
      readonly meta?: Readonly<Record<string, unknown>>;
      readonly onElicitation?: (
        request: CodexElicitationRequest,
      ) => CodexElicitationResponse | Promise<CodexElicitationResponse>;
    },
  ): Promise<CodexToolResult>;
  close(): Promise<void>;
}

export type CreateAgentdeskMcpServerOptions = {
  readonly appServer?: AgentdeskAppServer;
  readonly appServerOptions?: CodexAppServerClientOptions;
};

export type AgentdeskMcpServer = {
  readonly server: Server;
  readonly appServer: AgentdeskAppServer;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Preserve Codex's definition while correcting annotations at this boundary.
 * The upstream REPL describes its JavaScript dispatcher as read-only because
 * Codex performs risk review inside the call. To an MCP host, however, that
 * code can operate the live desktop and must never be auto-approved as a
 * read-only/idempotent tool. */
const asMcpTool = (tool: CodexTool): Tool => ({
  ...(tool as unknown as Tool),
  annotations: {
    ...tool.annotations,
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: tool.name === "js_reset",
    openWorldHint: tool.name === "js",
  },
});

/** Preserve every result content block, including base64 image blocks. */
const asMcpResult = (result: CodexToolResult): CallToolResult =>
  result as unknown as CallToolResult;

const guideResult = (): CallToolResult => {
  const envelope = guideEnvelope();
  return {
    structuredContent: { ...envelope },
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
  };
};

const toolFailure = (error: unknown): CallToolResult => {
  const message = error instanceof Error ? error.message : String(error);
  const envelope = {
    schema_version: 1 as const,
    ok: false as const,
    error: {
      code: "computer_use_failed",
      message,
      ...(RECOVERY === undefined ? {} : { recovery: RECOVERY }),
    },
    data: null,
  };
  const diagnostic = [
    `computer_use_failed: ${message}`,
    ...(RECOVERY === undefined ? [] : [`recovery: ${RECOVERY}`]),
  ].join("\n");
  return {
    isError: true,
    structuredContent: { ...envelope },
    content: [
      { type: "text", text: diagnostic },
      { type: "text", text: JSON.stringify(envelope, null, 2) },
    ],
  };
};

function requestedSchema(request: CodexElicitationRequest): Record<string, unknown> | undefined {
  if (!isRecord(request.requestedSchema)) return undefined;
  return request.requestedSchema;
}

function requestMeta(request: CodexElicitationRequest): Record<string, unknown> | undefined {
  return isRecord(request._meta) ? request._meta : undefined;
}

/**
 * Forward one Codex/app-server elicitation to the MCP host related to the
 * active tools/call request. Unsupported modes, missing capabilities, invalid
 * payloads, client errors, and malformed answers all cancel. Approval is
 * never synthesized.
 */
async function forwardElicitation(
  server: Server,
  request: CodexElicitationRequest,
  sendRequest: Parameters<Parameters<Server["setRequestHandler"]>[1]>[1]["sendRequest"],
  signal: AbortSignal,
): Promise<CodexElicitationResponse> {
  const capabilities = server.getClientCapabilities()?.elicitation;
  const meta = requestMeta(request);

  try {
    if (request.mode === "url") {
      if (
        capabilities?.url === undefined ||
        request.url === undefined ||
        request.elicitationId === undefined
      ) {
        return { action: "cancel" };
      }
      const result = await sendRequest(
        {
          method: "elicitation/create",
          params: {
            mode: "url",
            message: request.message,
            url: request.url,
            elicitationId: request.elicitationId,
            ...(meta === undefined ? {} : { _meta: meta }),
          },
        },
        ElicitResultSchema,
        { signal },
      );
      return {
        action: result.action,
        ...(result.content === undefined ? {} : { content: result.content }),
      };
    }

    // app-server uses `openaiForm`/`openai/form` for extended schemas. On the
    // MCP wire they remain form elicitations; the opaque schema and metadata
    // are preserved for a client that understands the extension.
    const schema = requestedSchema(request);
    if (capabilities?.form === undefined || schema === undefined) return { action: "cancel" };
    const result = await sendRequest(
      {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: request.message,
          requestedSchema: schema,
          ...(meta === undefined ? {} : { _meta: meta }),
        },
      },
      ElicitResultSchema,
      { signal },
    );
    return {
      action: result.action,
      ...(result.content === undefined ? {} : { content: result.content }),
    };
  } catch {
    return { action: "cancel" };
  }
}

export function createAgentdeskMcpServer(
  options: CreateAgentdeskMcpServerOptions = {},
): AgentdeskMcpServer {
  const appServer = options.appServer ?? new CodexAppServerClient(options.appServerOptions);
  const server = new Server(
    { name: CONTRACT.meta.name, version: CONTRACT.meta.version },
    {
      capabilities: { tools: {} },
      instructions: renderAgentHelp(CONTRACT),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const downstream = await appServer.listTools();
    const byName = new Map(downstream.map((tool) => [tool.name, tool]));
    const tools = ["js", "js_reset"].map((name) => {
      const tool = byName.get(name);
      if (tool === undefined) throw new Error(`Codex Computer Use did not advertise ${name}`);
      return asMcpTool(tool);
    });
    return { tools: [GUIDE_TOOL, ...tools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name === "guide") return guideResult();
    if (!COMPUTER_USE_TOOLS.has(request.params.name)) {
      return toolFailure(new Error(`Unknown Agentdesk tool: ${request.params.name}`));
    }
    try {
      const result = await appServer.callTool(request.params.name, request.params.arguments ?? {}, {
        signal: extra.signal,
        ...(request.params._meta === undefined ? {} : { meta: request.params._meta }),
        onElicitation: (elicitation) =>
          forwardElicitation(server, elicitation, extra.sendRequest, extra.signal),
      });
      return asMcpResult(result);
    } catch (error) {
      return toolFailure(error);
    }
  });

  return { server, appServer };
}
