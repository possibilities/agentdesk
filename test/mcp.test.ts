import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type CallToolResult, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  CodexElicitationRequest,
  CodexElicitationResponse,
  CodexTool,
  CodexToolResult,
} from "../src/codex-app-server.ts";
import { type AgentdeskAppServer, createAgentdeskMcpServer } from "../src/mcp-server.ts";

const TOOLS: readonly CodexTool[] = [
  {
    name: "js",
    description: "JavaScript to execute using the initialized CUA runtime.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        title: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1 },
      },
      required: ["code"],
      additionalProperties: false,
      "x-agentdesk-preserved": true,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "js_reset",
    description: "Reset the persistent CUA JavaScript session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

class FakeAppServer implements AgentdeskAppServer {
  closed = false;
  calls: Array<{
    name: string;
    args: unknown;
    signal: AbortSignal | undefined;
    meta: Readonly<Record<string, unknown>> | undefined;
  }> = [];
  result: CodexToolResult = { content: [{ type: "text", text: "ok" }] };
  elicitation?: CodexElicitationRequest;
  elicitationResponse?: CodexElicitationResponse;

  async listTools(): Promise<readonly CodexTool[]> {
    return TOOLS;
  }

  async callTool(
    name: string,
    args: unknown,
    options?: {
      readonly signal?: AbortSignal;
      readonly meta?: Readonly<Record<string, unknown>>;
      readonly onElicitation?: (
        request: CodexElicitationRequest,
      ) => CodexElicitationResponse | Promise<CodexElicitationResponse>;
    },
  ): Promise<CodexToolResult> {
    this.calls.push({ name, args, signal: options?.signal, meta: options?.meta });
    if (this.elicitation !== undefined) {
      this.elicitationResponse = await options?.onElicitation?.(this.elicitation);
    }
    return this.result;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

type Connected = {
  client: Client;
  server: ReturnType<typeof createAgentdeskMcpServer>["server"];
  fake: FakeAppServer;
};

const connected: Connected[] = [];

async function connect(
  fake = new FakeAppServer(),
  capabilities: ConstructorParameters<typeof Client>[1] = {},
): Promise<Connected> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agentdesk-test", version: "0" }, capabilities);
  const created = createAgentdeskMcpServer({ appServer: fake });
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  const value = { client, server: created.server, fake };
  connected.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(
    connected.splice(0).map(({ client, server }) => Promise.all([client.close(), server.close()])),
  );
});

describe("Agentdesk MCP", () => {
  test("lists guide and only the current cua_repl tools without rewriting their schemas", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["guide", "js", "js_reset"]);
    expect(tools.find((tool) => tool.name === "js")?.inputSchema).toEqual(
      TOOLS[0]?.inputSchema as { type: "object"; [key: string]: unknown },
    );
    expect(tools.find((tool) => tool.name === "js")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(tools.find((tool) => tool.name === "js_reset")?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test("guide returns the fleet contract as structuredContent and standalone JSON", async () => {
    const { client } = await connect();
    const result = (await client.callTool({ name: "guide", arguments: {} })) as CallToolResult;
    const text = result.content[0];

    expect(text?.type).toBe("text");
    if (text?.type !== "text") throw new Error("guide did not return text");
    const envelope = JSON.parse(text.text);
    expect(result.structuredContent).toEqual(envelope);
    expect(envelope).toMatchObject({
      schema_version: 1,
      ok: true,
      error: null,
      data: { contract_version: 1, meta: { name: "agentdesk" } },
    });
  });

  test("passes arguments and request cancellation while preserving text, image, structured, and meta output", async () => {
    const fake = new FakeAppServer();
    fake.result = {
      content: [
        { type: "text", text: "state" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      structuredContent: { app: "TextEdit" },
      _meta: { "codex/imageDetail": "original" },
    };
    const { client } = await connect(fake);
    const result = (await client.callTool({
      name: "js",
      arguments: { code: "await cua.getState()", title: "Inspect the desktop" },
    })) as CallToolResult;

    expect(fake.calls[0]).toMatchObject({
      name: "js",
      args: { code: "await cua.getState()", title: "Inspect the desktop" },
    });
    expect(fake.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(result.content as readonly unknown[]).toEqual(fake.result.content);
    expect(result.structuredContent).toEqual({ app: "TextEdit" });
    expect(result._meta).toEqual({ "codex/imageDetail": "original" });
  });

  test("forwards form elicitations to the MCP client and returns its exact decision", async () => {
    const fake = new FakeAppServer();
    fake.elicitation = {
      mode: "form",
      message: "Allow Computer Use to control TextEdit?",
      requestedSchema: {
        type: "object",
        properties: { allow: { type: "boolean" } },
        required: ["allow"],
      },
      _meta: { connector_name: "Computer Use" },
      serverName: "cua_repl",
      threadId: "thread-1",
      turnId: null,
    };
    const { client } = await connect(fake, {
      capabilities: { elicitation: { form: {} } },
    });
    let seen: unknown;
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      seen = request.params;
      return { action: "accept", content: { allow: true } };
    });

    await client.callTool({ name: "js", arguments: { code: "await cua.getState()" } });

    expect(seen).toMatchObject({
      mode: "form",
      message: "Allow Computer Use to control TextEdit?",
      _meta: { connector_name: "Computer Use" },
    });
    expect(fake.elicitationResponse).toEqual({ action: "accept", content: { allow: true } });
  });

  test("cancels an elicitation when the client does not advertise support", async () => {
    const fake = new FakeAppServer();
    fake.elicitation = {
      mode: "url",
      message: "Open approval page?",
      url: "https://example.test/approve",
      elicitationId: "approval-1",
      serverName: "cua_repl",
      threadId: "thread-1",
    };
    const { client } = await connect(fake);

    await client.callTool({ name: "js", arguments: { code: "await cua.getState()" } });

    expect(fake.elicitationResponse).toEqual({ action: "cancel" });
  });

  test("cancels a malformed elicitation without asking the MCP client", async () => {
    const fake = new FakeAppServer();
    fake.elicitation = {
      mode: "form",
      message: "Malformed prompt",
      serverName: "cua_repl",
      threadId: "thread-1",
    };
    const { client } = await connect(fake, {
      capabilities: { elicitation: { form: {} } },
    });
    let prompted = false;
    client.setRequestHandler(ElicitRequestSchema, () => {
      prompted = true;
      return { action: "accept", content: {} };
    });

    await client.callTool({ name: "js", arguments: { code: "await cua.getState()" } });

    expect(prompted).toBe(false);
    expect(fake.elicitationResponse).toEqual({ action: "cancel" });
  });

  test("propagates cancellation to the app-server call", async () => {
    const fake = new FakeAppServer();
    let downstreamAborted = false;
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    fake.callTool = (_name, _args, options) =>
      new Promise((_resolve, reject) => {
        markEntered?.();
        options?.signal?.addEventListener(
          "abort",
          () => {
            downstreamAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    const { client } = await connect(fake);
    const controller = new AbortController();
    const call = client.callTool(
      { name: "js", arguments: { code: "await cua.getState()" } },
      undefined,
      { signal: controller.signal },
    );

    await entered;
    controller.abort();

    await expect(call).rejects.toThrow();
    await Bun.sleep(0);
    expect(downstreamAborted).toBe(true);
  });

  test("returns bridge failures as a tool error plus a standalone JSON envelope", async () => {
    const fake = new FakeAppServer();
    fake.callTool = async () => {
      throw new Error("cua_repl is unavailable");
    };
    const { client } = await connect(fake);
    const result = (await client.callTool({
      name: "js_reset",
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("computer_use_failed: cua_repl is unavailable"),
    });
    const json = result.content[1];
    if (json?.type !== "text") throw new Error("missing JSON error block");
    const envelope = JSON.parse(json.text);
    expect(result.structuredContent).toEqual(envelope);
    expect(envelope).toMatchObject({
      schema_version: 1,
      ok: false,
      error: { code: "computer_use_failed", message: "cua_repl is unavailable" },
      data: null,
    });
  });
});
