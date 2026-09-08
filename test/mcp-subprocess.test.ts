import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
let fixtureDirectory = "";
let fakeCodex = "";

const fakeServer = String.raw`#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const log = (value) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(value) + "\n");
};
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let exiting = false;
const exit = (reason) => {
  if (exiting) return;
  exiting = true;
  log({ event: "exiting", pid: process.pid, reason });
  process.exit(0);
};

log({ event: "started", pid: process.pid, argv: process.argv.slice(2) });
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-subprocess", ephemeral: true } } });
    return;
  }
  if (message.method === "mcpServerStatus/list") {
    send({ id: message.id, result: { data: [{
      name: "cua_repl",
      pluginId: "unified-computer-use@openai-bundled",
      runtimeStatus: "connected",
      tools: {
        js: {
          description: "Execute fixture-backed CUA JavaScript",
          inputSchema: {
            type: "object",
            properties: { code: { type: "string" }, title: { type: "string" } },
            required: ["code"],
            additionalProperties: false,
          },
        },
        js_reset: {
          description: "Reset fixture CUA state",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      },
    }], nextCursor: null } });
    return;
  }
  if (message.method === "mcpServer/tool/call") {
    const code = message.params.arguments?.code ?? "reset";
    log({ event: "call", pid: process.pid, tool: message.params.tool, code });
    send({ id: message.id, result: {
      content: [{ type: "text", text: "fixture desktop state" }],
      structuredContent: { fixture: true, code },
      isError: false,
    } });
  }
});
input.on("close", () => exit("stdin-end"));
process.on("SIGTERM", () => exit("sigterm"));
`;

type LogEntry = {
  readonly event?: string;
  readonly pid?: number;
  readonly [key: string]: unknown;
};

const readLog = (path: string): LogEntry[] => {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

async function waitFor<T>(read: () => T | undefined, timeoutMs = 6_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

const waitForExit = (pid: number): Promise<boolean> =>
  waitFor(() => (isAlive(pid) ? undefined : true));

function connect(name: string): {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly logPath: string;
} {
  const logPath = join(fixtureDirectory, `${name}.jsonl`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    env: {
      AGENTDESK_CODEX_HOME: join(fixtureDirectory, `${name}-home`),
      AGENTDESK_CODEX_BIN: fakeCodex,
      FAKE_LOG: logPath,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "agentdesk-subprocess-test", version: "0" });
  return { client, transport, logPath };
}

beforeAll(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "agentdesk-mcp-subprocess-"));
  fakeCodex = join(fixtureDirectory, "codex");
  writeFileSync(fakeCodex, fakeServer);
  chmodSync(fakeCodex, 0o755);
});

afterAll(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

describe("Agentdesk MCP subprocess lifecycle", () => {
  test("serves the real stdio contract and reaps Agentdesk and Codex on client close", async () => {
    const { client, transport, logPath } = connect("client-close");
    await client.connect(transport);
    const agentdeskPid = transport.pid;
    if (agentdeskPid === null) throw new Error("Agentdesk subprocess did not start");

    const guide = await client.callTool({ name: "guide", arguments: {} });
    expect(guide.structuredContent).toMatchObject({
      schema_version: 1,
      ok: true,
      data: { meta: { name: "agentdesk" } },
    });
    expect(existsSync(logPath)).toBe(false);

    // The MCP process and its static guide stay cheap. Dynamic tools/list is
    // the first operation that needs Codex so Agentdesk can preserve the
    // installed CUA schemas rather than shipping a stale copy.
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["guide", "js", "js_reset"]);

    const result = await client.callTool({
      name: "js",
      arguments: { code: "return { fixture: true }", title: "Read fixture state" },
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "fixture desktop state" }],
      structuredContent: { fixture: true, code: "return { fixture: true }" },
      isError: false,
    });

    const codexPid = await waitFor(
      () => readLog(logPath).find((entry) => entry.event === "started")?.pid,
    );
    expect(isAlive(agentdeskPid)).toBe(true);
    expect(isAlive(codexPid)).toBe(true);

    const closeStartedAt = performance.now();
    await client.close();
    const closeDurationMs = performance.now() - closeStartedAt;

    await Promise.all([waitForExit(agentdeskPid), waitForExit(codexPid)]);
    // The SDK transport sends SIGTERM after two seconds if EOF does not stop
    // its child. Finishing promptly proves Agentdesk handled stdin EOF itself.
    expect(closeDurationMs).toBeLessThan(1_000);
    expect(readLog(logPath)).toContainEqual(
      expect.objectContaining({ event: "exiting", pid: codexPid }),
    );
  }, 10_000);

  test("SIGTERM stops the MCP process and reaps its Codex child", async () => {
    const { client, transport, logPath } = connect("sigterm");
    await client.connect(transport);
    await client.listTools();
    const agentdeskPid = transport.pid;
    if (agentdeskPid === null) throw new Error("Agentdesk subprocess did not start");
    const codexPid = await waitFor(
      () => readLog(logPath).find((entry) => entry.event === "started")?.pid,
    );

    process.kill(agentdeskPid, "SIGTERM");
    await Promise.all([waitForExit(agentdeskPid), waitForExit(codexPid)]);
    await client.close();

    expect(readLog(logPath)).toContainEqual(
      expect.objectContaining({ event: "exiting", pid: codexPid }),
    );
  }, 10_000);
});
