import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CodexAppServerClient,
  resolveCodexBinary,
  resolveCodexHome,
} from "../src/codex-app-server.ts";

let fixtureDirectory = "";
let fakeCodex = "";

const fakeServer = String.raw`#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const log = (value) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(value) + "\n");
};
log({ event: "started", argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME });

const input = readline.createInterface({ input: process.stdin });
let waitingCall;
let activeCalls = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");

input.on("line", (line) => {
  const message = JSON.parse(line);
  log({ event: "message", message });
  if (message.method === "initialize") {
    send({ id: message.id, result: { platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    if (process.env.FAKE_THREAD_MODE === "malformed") {
      send({ id: message.id, result: { thread: { ephemeral: true } } });
      return;
    }
    send({ id: message.id, result: { thread: { id: "thread-fixture", ephemeral: true } } });
    return;
  }
  if (message.method === "mcpServerStatus/list") {
    if (process.env.FAKE_STATUS_MODE === "paginate" && message.params.cursor == null) {
      send({ id: message.id, result: { data: [{
        name: "unrelated",
        pluginId: "unrelated@fixture",
        runtimeStatus: "connected",
        tools: {},
      }], nextCursor: "page-2" } });
      return;
    }
    if (process.env.FAKE_STATUS_MODE === "cycle") {
      send({ id: message.id, result: { data: [{
        name: "unrelated",
        pluginId: "unrelated@fixture",
        runtimeStatus: "connected",
        tools: {},
      }], nextCursor: "same-page" } });
      return;
    }
    if (process.env.FAKE_STATUS_MODE === "malformed-cursor") {
      send({ id: message.id, result: { data: [], nextCursor: 42 } });
      return;
    }
    send({ id: message.id, result: { data: [{
      name: "cua_repl",
      pluginId: process.env.FAKE_PLUGIN_ID ?? "unified-computer-use@openai-bundled",
      runtimeStatus: process.env.FAKE_RUNTIME_STATUS ?? "connected",
      tools: {
        js: { description: "Execute CUA JavaScript", inputSchema: { type: "object" } },
        js_reset: { description: "Reset CUA JavaScript", inputSchema: { type: "object" } },
        hidden: { description: "Must not escape", inputSchema: { type: "object" } },
      },
    }], nextCursor: null } });
    return;
  }
  if (message.method === "mcpServer/tool/call") {
    activeCalls += 1;
    log({ event: "call", activeCalls, code: message.params.arguments?.code });
    const finish = (content) => {
      activeCalls -= 1;
      send({ id: message.id, result: {
        content: [{ type: "text", text: content }],
        structuredContent: { content },
        isError: false,
        _meta: { downstream: true, request: message.params },
      } });
    };
    if (message.params.arguments?.code === "elicit") {
      waitingCall = { finish };
      send({ id: "approval-1", method: "mcpServer/elicitation/request", params: {
        serverName: "cua_repl",
        threadId: "thread-fixture",
        turnId: null,
        mode: "form",
        message: "Allow Computer Use to use Finder?",
        requestedSchema: { type: "object", properties: {} },
        _meta: { persist: ["session", "always"] },
      } });
      return;
    }
    if (message.params.arguments?.code === "hang") return;
    if (message.params.arguments?.code === "malformed") {
      process.stdout.write("{not-json\n");
      return;
    }
    const delay = message.params.arguments?.code === "first" ? 40 : 0;
    setTimeout(() => finish(message.params.arguments?.code ?? "reset"), delay);
    return;
  }
  if (message.id === "approval-1" && waitingCall) {
    log({ event: "elicitation-response", result: message.result });
    waitingCall.finish(message.result.action);
    waitingCall = undefined;
  }
});

process.on("SIGTERM", () => {
  log({ event: "sigterm" });
  setTimeout(() => {
    log({ event: "reaped" });
    process.exit(0);
  }, Number(process.env.FAKE_TERM_DELAY ?? 0));
});
`;

const readLog = (path: string): Array<Record<string, unknown>> =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const makeClient = (name: string, extra: Record<string, string> = {}) => {
  const selectedHome = join(fixtureDirectory, `${name}-home`);
  const logPath = join(fixtureDirectory, `${name}.jsonl`);
  const client = new CodexAppServerClient({
    env: {
      ...process.env,
      CODEX_HOME: join(fixtureDirectory, "ambient-home-must-not-win"),
      AGENTDESK_CODEX_HOME: selectedHome,
      AGENTDESK_CODEX_BIN: fakeCodex,
      FAKE_LOG: logPath,
      ...extra,
    },
  });
  return { client, logPath, selectedHome };
};

beforeAll(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "agentdesk-app-server-"));
  fakeCodex = join(fixtureDirectory, "codex");
  writeFileSync(fakeCodex, fakeServer);
  chmodSync(fakeCodex, 0o755);
});

afterAll(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

describe("Codex app-server client", () => {
  test("resolves only explicit or supported Codex locations", () => {
    expect(
      resolveCodexHome({
        AGENTDESK_CODEX_HOME: "/selected/codex",
        CODEX_HOME: "/ambient/codex",
      }),
    ).toBe("/selected/codex");
    expect(resolveCodexBinary("/unused", { AGENTDESK_CODEX_BIN: fakeCodex })).toBe(fakeCodex);
    expect(() => resolveCodexHome({ AGENTDESK_CODEX_HOME: "relative" })).toThrow("absolute");
  });

  test("starts lazily with the required capability and exposes only the CUA REPL tools", async () => {
    const { client, logPath, selectedHome } = makeClient("catalog");
    expect(existsSync(logPath)).toBe(false);

    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["js", "js_reset"]);
    await client.close();

    const log = readLog(logPath);
    expect(log[0]).toMatchObject({
      event: "started",
      argv: ["app-server"],
      codexHome: selectedHome,
    });
    const messages = log
      .filter((entry) => entry.event === "message")
      .map((entry) => entry.message as Record<string, unknown>);
    expect(messages[0]).toMatchObject({
      method: "initialize",
      params: {
        capabilities: {
          mcpServerOpenaiFormElicitation: true,
          extensions: {
            "openai/form": {},
            "openai/standard-form-input": {},
          },
        },
      },
    });
    expect(messages[2]).toMatchObject({
      method: "thread/start",
      params: { ephemeral: true, approvalPolicy: "on-request" },
    });
  });

  test("paginates status discovery and rejects cyclic or malformed cursors", async () => {
    const paginated = makeClient("paginated", { FAKE_STATUS_MODE: "paginate" });
    expect((await paginated.client.listTools()).map((tool) => tool.name)).toEqual([
      "js",
      "js_reset",
    ]);
    await paginated.client.close();
    const statusRequests = readLog(paginated.logPath).filter(
      (entry) =>
        entry.event === "message" &&
        (entry.message as Record<string, unknown>).method === "mcpServerStatus/list",
    );
    expect(statusRequests).toHaveLength(2);

    const cyclic = makeClient("cyclic", { FAKE_STATUS_MODE: "cycle" });
    await expect(cyclic.client.listTools()).rejects.toThrow("cyclic MCP status cursor");
    await cyclic.client.close();

    const malformed = makeClient("malformed-cursor", {
      FAKE_STATUS_MODE: "malformed-cursor",
    });
    await expect(malformed.client.listTools()).rejects.toThrow("malformed MCP status cursor");
    await malformed.client.close();
  });

  test("forwards elicitations and preserves the full tool result", async () => {
    const { client, logPath } = makeClient("elicitation");
    const result = await client.callTool(
      "js",
      { code: "elicit" },
      {
        onElicitation: async (request) => {
          expect(request).toMatchObject({
            mode: "form",
            message: "Allow Computer Use to use Finder?",
            _meta: { persist: ["session", "always"] },
          });
          return { action: "accept", content: {}, _meta: { persist: "session" } };
        },
      },
    );
    expect(result).toMatchObject({
      content: [{ type: "text", text: "accept" }],
      structuredContent: { content: "accept" },
      isError: false,
      _meta: { downstream: true },
    });
    await client.close();

    expect(readLog(logPath)).toContainEqual(
      expect.objectContaining({
        event: "elicitation-response",
        result: { action: "accept", content: {}, _meta: { persist: "session" } },
      }),
    );
  });

  test("serializes calls and does not restart until an aborted child is reaped", async () => {
    const { client, logPath } = makeClient("serial", { FAKE_TERM_DELAY: "50" });
    const [first, second] = await Promise.all([
      client.callTool("js", { code: "first" }),
      client.callTool("js", { code: "second" }),
    ]);
    expect(first.content).toEqual([{ type: "text", text: "first" }]);
    expect(second.content).toEqual([{ type: "text", text: "second" }]);
    const calls = readLog(logPath).filter((entry) => entry.event === "call");
    expect(calls.map((entry) => entry.code)).toEqual(["first", "second"]);
    expect(calls.every((entry) => entry.activeCalls === 1)).toBe(true);

    const controller = new AbortController();
    const pending = client.callTool("js", { code: "hang" }, { signal: controller.signal });
    const queued = client.callTool("js", { code: "after-abort" });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect((await queued).content).toEqual([{ type: "text", text: "after-abort" }]);
    await client.close();

    const lifecycle = readLog(logPath);
    const reaped = lifecycle.findIndex((entry) => entry.event === "reaped");
    const restarted = lifecycle.findIndex((entry, index) => index > 0 && entry.event === "started");
    expect(reaped).toBeGreaterThan(-1);
    expect(restarted).toBeGreaterThan(reaped);
  });

  test("terminates and reaps a child that emits malformed stdout", async () => {
    const { client, logPath } = makeClient("malformed-output", { FAKE_TERM_DELAY: "40" });
    await expect(client.callTool("js", { code: "malformed" })).rejects.toThrow("invalid JSON");
    expect(
      readLog(logPath)
        .slice(-2)
        .map((entry) => entry.event),
    ).toEqual(["sigterm", "reaped"]);
  });

  test("reaps the child before surfacing a malformed thread/start response", async () => {
    const { client, logPath } = makeClient("malformed-thread", {
      FAKE_THREAD_MODE: "malformed",
      FAKE_TERM_DELAY: "40",
    });
    await expect(client.listTools()).rejects.toThrow("invalid thread/start response");
    expect(
      readLog(logPath)
        .slice(-2)
        .map((entry) => entry.event),
    ).toEqual(["sigterm", "reaped"]);
  });

  test("fails closed when cua_repl is not the bundled Computer Use server", async () => {
    const { client } = makeClient("identity", { FAKE_PLUGIN_ID: "other@marketplace" });
    await expect(client.listTools()).rejects.toThrow("unexpected plugin identity");
    await client.close();
  });
});
