import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

const SERVER_NAME = "cua_repl";
const PLUGIN_ID = "unified-computer-use@openai-bundled";
const STARTUP_TIMEOUT_MS = 120_000;
const STDERR_LIMIT = 8_192;
const MAX_STATUS_PAGES = 128;

type Environment = Readonly<Record<string, string | undefined>>;
type RequestId = number | string;

export type CodexTool = Tool;
export type CodexToolResult = CallToolResult;

export type CodexElicitationRequest = {
  readonly mode: "form" | "openai/form" | "openaiForm" | "url";
  readonly message: string;
  readonly requestedSchema?: unknown;
  readonly url?: string;
  readonly elicitationId?: string;
  readonly _meta?: unknown;
  readonly serverName: string;
  readonly threadId: string;
  readonly turnId?: string | null;
};

export type CodexElicitationResponse = {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: unknown;
  readonly _meta?: unknown;
};

export type CallToolOptions = {
  readonly signal?: AbortSignal;
  /** Caller metadata forwarded to Codex, except for Codex turn identity which
   * Agentdesk always creates for its own ephemeral session. */
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly onElicitation?: (
    request: CodexElicitationRequest,
  ) => CodexElicitationResponse | Promise<CodexElicitationResponse>;
};

export type CodexAppServerClientOptions = {
  readonly cwd?: string;
  readonly env?: Environment;
};

type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout?: ReturnType<typeof setTimeout>;
  readonly removeAbort?: () => void;
};

type WireMessage = {
  readonly id?: RequestId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export const resolveCodexHome = (env: Environment = process.env): string => {
  const selected = env.AGENTDESK_CODEX_HOME ?? join(homedir(), ".codex");
  if (!isAbsolute(selected)) {
    throw new Error("AGENTDESK_CODEX_HOME must be an absolute path");
  }
  return selected;
};

export const resolveCodexBinary = (codexHome: string, env: Environment = process.env): string => {
  const override = env.AGENTDESK_CODEX_BIN;
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new Error("AGENTDESK_CODEX_BIN must be an absolute path");
    }
    if (!isExecutable(override)) {
      throw new Error(`AGENTDESK_CODEX_BIN is not executable: ${override}`);
    }
    return override;
  }

  const candidates = [
    join(codexHome, "packages", "standalone", "current", "bin", "codex"),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  ];
  const selected = candidates.find(isExecutable);
  if (selected === undefined) {
    throw new Error(
      `Could not find a supported Codex binary. Checked ${candidates.join(" and ")}.`,
    );
  }
  return selected;
};

const errorMessage = (value: unknown): string => {
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return JSON.stringify(value);
};

const abortError = (): Error => {
  const error = new Error("Codex Computer Use call was aborted");
  error.name = "AbortError";
  return error;
};

/**
 * A lazy, session-scoped client for Codex's app-server Computer Use bridge.
 * One instance owns one app-server child and one ephemeral thread. Tool calls
 * are serialized because the node REPL and Sky's accessibility diffs are
 * persistent session state.
 */
export class CodexAppServerClient {
  readonly #cwd: string | undefined;
  readonly #env: Environment;
  #child: ChildProcessWithoutNullStreams | undefined;
  #stdoutBuffer = "";
  #stderr = "";
  #nextId = 1;
  #threadId: string | undefined;
  #tools: CodexTool[] | undefined;
  #starting: Promise<void> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #pending = new Map<number, PendingRequest>();
  #activeElicitation: CallToolOptions["onElicitation"];
  #explicitlyClosed = false;
  #exitPromise: Promise<void> | undefined;
  #resolveExit: (() => void) | undefined;
  #termination: Promise<void> | undefined;
  #terminalFailure: Error | undefined;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.#cwd = options.cwd;
    this.#env = options.env ?? process.env;
  }

  async listTools(): Promise<CodexTool[]> {
    return this.#serialize(async () => {
      await this.#ensureStarted();
      return this.#loadTools();
    });
  }

  async callTool(
    name: string,
    args: unknown = {},
    options: CallToolOptions = {},
  ): Promise<CodexToolResult> {
    if (name !== "js" && name !== "js_reset") {
      throw new Error(`Unsupported Codex Computer Use tool: ${name}`);
    }
    if (options.signal?.aborted) throw abortError();

    return this.#serialize(async () => {
      if (options.signal?.aborted) throw abortError();
      await this.#ensureStarted();
      await this.#loadTools();
      this.#activeElicitation = options.onElicitation;
      try {
        const result = await this.#request(
          "mcpServer/tool/call",
          {
            threadId: this.#threadId,
            server: SERVER_NAME,
            tool: name,
            arguments: args,
            _meta: {
              ...options.meta,
              "x-codex-turn-metadata": {
                session_id: this.#threadId,
                turn_id: randomUUID(),
              },
            },
          },
          { signal: options.signal },
        );
        if (!isRecord(result) || !Array.isArray(result.content)) {
          throw new Error("Codex app-server returned an invalid MCP tool result");
        }
        return {
          content: result.content,
          ...(Object.hasOwn(result, "structuredContent")
            ? { structuredContent: result.structuredContent }
            : {}),
          ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
          ...(Object.hasOwn(result, "_meta") ? { _meta: result._meta } : {}),
        } as CodexToolResult;
      } finally {
        this.#activeElicitation = undefined;
      }
    });
  }

  async close(): Promise<void> {
    this.#explicitlyClosed = true;
    this.#starting = undefined;
    this.#threadId = undefined;
    this.#tools = undefined;
    await this.#terminateChild();
  }

  async #serialize<A>(operation: () => Promise<A>): Promise<A> {
    const previous = this.#queue;
    let release: (() => void) | undefined;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  async #ensureStarted(): Promise<void> {
    if (this.#child !== undefined && this.#threadId !== undefined) return;
    if (this.#explicitlyClosed) {
      throw new Error("Codex app-server client is closed");
    }
    if (this.#starting !== undefined) return this.#starting;

    const start = this.#start();
    this.#starting = start;
    try {
      await start;
    } finally {
      if (this.#starting === start) this.#starting = undefined;
    }
  }

  async #start(): Promise<void> {
    const codexHome = resolveCodexHome(this.#env);
    const binary = resolveCodexBinary(codexHome, this.#env);
    const childEnv: Record<string, string | undefined> = {
      ...this.#env,
      CODEX_HOME: codexHome,
    };
    delete childEnv.AGENTDESK_CODEX_HOME;
    delete childEnv.AGENTDESK_CODEX_BIN;

    const child = spawn(binary, ["app-server"], {
      cwd: this.#cwd,
      env: childEnv as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    this.#stdoutBuffer = "";
    this.#stderr = "";
    this.#terminalFailure = undefined;
    this.#termination = undefined;
    this.#exitPromise = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", (error) => {
      void this.#terminateChild(error);
    });
    child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    child.stdout.on("error", (error) => {
      void this.#terminateChild(error);
    });
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-STDERR_LIMIT);
    });
    child.on("error", (error) => {
      void this.#terminateChild(error);
    });
    child.on("close", (code, signal) => {
      const detail = signal === null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`;
      this.#onChildClosed(new Error(`Codex app-server exited with ${detail}`));
    });

    try {
      const initialized = await this.#request(
        "initialize",
        {
          clientInfo: { name: "agentdesk", title: "Agentdesk", version: "0.1.0" },
          capabilities: {
            mcpServerOpenaiFormElicitation: true,
            extensions: {
              "openai/form": {},
              "openai/standard-form-input": {},
            },
          },
        },
        { timeoutMs: STARTUP_TIMEOUT_MS },
      );
      if (!isRecord(initialized)) {
        throw new Error("Codex app-server returned an invalid initialize response");
      }
      this.#send({ method: "initialized", params: {} });
      const started = await this.#request(
        "thread/start",
        {
          ephemeral: true,
          sessionStartSource: "startup",
          approvalPolicy: "on-request",
        },
        { timeoutMs: STARTUP_TIMEOUT_MS },
      );
      if (
        !isRecord(started) ||
        !isRecord(started.thread) ||
        typeof started.thread.id !== "string"
      ) {
        throw new Error("Codex app-server returned an invalid thread/start response");
      }
      this.#threadId = started.thread.id;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      await this.#terminateChild(failure);
      throw failure;
    }
  }

  #decodeServerStatusPage(result: unknown): {
    readonly status?: Record<string, unknown>;
    readonly nextCursor?: string;
  } {
    if (!isRecord(result) || !Array.isArray(result.data)) {
      throw new Error("Codex app-server returned an invalid MCP status response");
    }
    for (const entry of result.data) {
      if (!isRecord(entry) || typeof entry.name !== "string") {
        throw new Error("Codex app-server returned a malformed MCP status entry");
      }
    }
    if (
      result.nextCursor !== undefined &&
      result.nextCursor !== null &&
      typeof result.nextCursor !== "string"
    ) {
      throw new Error("Codex app-server returned a malformed MCP status cursor");
    }
    const status = result.data.find((entry) => entry.name === SERVER_NAME);
    return {
      ...(status === undefined ? {} : { status }),
      ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
    };
  }

  #validateServerStatus(status: Record<string, unknown>): void {
    if (status.pluginId !== PLUGIN_ID) {
      throw new Error(
        `Codex MCP server ${SERVER_NAME} has unexpected plugin identity ${String(status.pluginId)}`,
      );
    }
    if (status.runtimeStatus !== "connected") {
      throw new Error(
        `Codex MCP server ${SERVER_NAME} is not connected (status: ${String(status.runtimeStatus)})`,
      );
    }
  }

  async #loadTools(): Promise<CodexTool[]> {
    if (this.#tools !== undefined) return this.#tools;
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let status: Record<string, unknown> | undefined;
    for (let page = 0; page < MAX_STATUS_PAGES; page += 1) {
      const result = await this.#request(
        "mcpServerStatus/list",
        {
          threadId: this.#threadId,
          detail: "toolsAndAuthOnly",
          ...(cursor === undefined ? {} : { cursor }),
        },
        { timeoutMs: STARTUP_TIMEOUT_MS },
      );
      const decoded = this.#decodeServerStatusPage(result);
      if (decoded.status !== undefined) {
        status = decoded.status;
        break;
      }
      if (decoded.nextCursor === undefined) break;
      if (seenCursors.has(decoded.nextCursor)) {
        throw new Error("Codex app-server returned a cyclic MCP status cursor");
      }
      seenCursors.add(decoded.nextCursor);
      cursor = decoded.nextCursor;
    }
    if (status === undefined) {
      throw new Error(
        `Codex does not expose ${SERVER_NAME}; install and enable unified-computer-use@openai-bundled`,
      );
    }
    this.#validateServerStatus(status);
    const tools = status.tools;
    if (!isRecord(tools)) {
      throw new Error(`Codex MCP server ${SERVER_NAME} returned an invalid tool catalog`);
    }

    const selected: CodexTool[] = [];
    for (const name of ["js", "js_reset"]) {
      const tool = tools[name];
      if (!isRecord(tool)) {
        throw new Error(`Codex MCP server ${SERVER_NAME} is missing required tool ${name}`);
      }
      selected.push({
        ...(tool as Omit<CodexTool, "name">),
        name,
        inputSchema: tool.inputSchema ?? { type: "object" },
      } as CodexTool);
    }
    this.#tools = selected;
    return selected;
  }

  #request(
    method: string,
    params: unknown,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const child = this.#child;
    if (child === undefined) return Promise.reject(new Error("Codex app-server is not running"));
    if (options.signal?.aborted) return Promise.reject(abortError());

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          this.#pending.delete(id);
          options.signal?.removeEventListener("abort", onAbort);
          const failure = new Error(`Codex app-server timed out during ${method}`);
          void this.#terminateChild(failure).then(() => reject(failure));
        }, options.timeoutMs);
        timeout.unref();
      }
      const onAbort = () => {
        this.#pending.delete(id);
        if (timeout !== undefined) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        const failure = abortError();
        void this.#terminateChild().then(() => reject(failure));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve,
        reject,
        ...(timeout === undefined ? {} : { timeout }),
        ...(options.signal === undefined
          ? {}
          : { removeAbort: () => options.signal?.removeEventListener("abort", onAbort) }),
      });
      this.#send({ id, method, params });
    });
  }

  #send(message: WireMessage): void {
    try {
      this.#child?.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      void this.#terminateChild(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #onStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    const lines = this.#stdoutBuffer.split("\n");
    this.#stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        void this.#terminateChild(new Error("Codex app-server emitted invalid JSON"));
        return;
      }
      if (!isRecord(parsed)) continue;
      this.#onMessage(parsed);
    }
  }

  #onMessage(message: WireMessage): void {
    if (message.method !== undefined && message.id !== undefined) {
      if (message.method === "mcpServer/elicitation/request") {
        void this.#handleElicitation(message.id, message.params);
      } else {
        this.#send({
          id: message.id,
          error: { code: -32601, message: `Agentdesk does not handle ${message.method}` },
        } as WireMessage);
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    pending.removeAbort?.();
    if (message.error !== undefined) {
      pending.reject(new Error(`Codex app-server request failed: ${errorMessage(message.error)}`));
    } else {
      pending.resolve(message.result);
    }
  }

  async #handleElicitation(id: RequestId, params: unknown): Promise<void> {
    const callback = this.#activeElicitation;
    if (callback === undefined || !isRecord(params)) {
      this.#send({ id, result: { action: "cancel" } });
      return;
    }
    try {
      const response = await callback(params as CodexElicitationRequest);
      if (!isRecord(response) || !["accept", "decline", "cancel"].includes(response.action)) {
        this.#send({ id, result: { action: "cancel" } });
        return;
      }
      this.#send({ id, result: response });
    } catch {
      this.#send({ id, result: { action: "cancel" } });
    }
  }

  #terminateChild(failure?: Error): Promise<void> {
    if (failure !== undefined && this.#terminalFailure === undefined) {
      this.#terminalFailure = failure;
    }
    if (this.#termination !== undefined) return this.#termination;
    const child = this.#child;
    const exit = this.#exitPromise;
    if (child === undefined || exit === undefined) return Promise.resolve();

    this.#termination = (async () => {
      child.stdin.end();
      child.kill("SIGTERM");
      const escalation = setTimeout(() => child.kill("SIGKILL"), 3_000);
      escalation.unref();
      await exit;
      clearTimeout(escalation);
    })();
    return this.#termination;
  }

  #onChildClosed(error: Error): void {
    if (this.#child === undefined) return;
    const stderr = this.#stderr.trim();
    const cause = this.#terminalFailure ?? error;
    const failure = stderr === "" ? cause : new Error(`${cause.message}: ${stderr}`);
    this.#child = undefined;
    this.#threadId = undefined;
    this.#tools = undefined;
    for (const pending of this.#pending.values()) {
      if (pending.timeout !== undefined) clearTimeout(pending.timeout);
      pending.removeAbort?.();
      pending.reject(failure);
    }
    this.#pending.clear();
    this.#resolveExit?.();
    this.#resolveExit = undefined;
    this.#exitPromise = undefined;
    this.#terminalFailure = undefined;
  }
}
