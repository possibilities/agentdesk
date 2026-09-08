#!/usr/bin/env bun

import { CodexAppServerClient } from "./codex-app-server.ts";
import {
  CONTRACT,
  guideEnvelope,
  renderAgentHelp,
  renderCommandHelp,
  renderTeaser,
  renderTopHelp,
} from "./contract.ts";
import { renderDoctor, runDoctor } from "./doctor.ts";
import { serveAgentdeskMcp } from "./mcp.ts";

class UsageError extends Error {}

const write = (value: string): void => {
  process.stdout.write(value);
};

const writeError = (value: string): void => {
  process.stderr.write(value);
};

const commandNames = new Set(CONTRACT.commands.map((command) => command.name));

type JsOptions = {
  readonly code: string;
  readonly timeout_ms?: number;
  readonly title?: string;
};

function parseJs(args: readonly string[]): JsOptions | "help" {
  let code: string | undefined;
  let timeout: number | undefined;
  let title: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help") return "help";
    const next = args[index + 1];
    if (argument === "--code" || argument === "--title" || argument === "--timeout-ms") {
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--code") code = next;
      if (argument === "--title") title = next;
      if (argument === "--timeout-ms") {
        timeout = Number(next);
        if (!Number.isSafeInteger(timeout) || timeout < 1) {
          throw new UsageError("--timeout-ms must be a positive integer");
        }
      }
      continue;
    }
    throw new UsageError(`Unknown js option: ${argument ?? ""}`);
  }
  if (code === undefined) throw new UsageError("js requires --code");
  return {
    code,
    ...(timeout === undefined ? {} : { timeout_ms: timeout }),
    ...(title === undefined ? {} : { title }),
  };
}

function noArguments(command: string, args: readonly string[]): "run" | "help" {
  if (args.length === 0) return "run";
  if (args.length === 1 && args[0] === "--help") return "help";
  throw new UsageError(`${command} takes no arguments`);
}

const success = (data: unknown) => ({
  schema_version: 1 as const,
  ok: true as const,
  error: null,
  data,
});

async function oneShotTool(name: "js" | "js_reset", args: unknown): Promise<void> {
  const client = new CodexAppServerClient();
  try {
    const result = await client.callTool(name, args, {
      // A terminal invocation has no related MCP client to present a consent
      // form. Cancel rather than manufacturing an approval.
      onElicitation: () => ({ action: "cancel" }),
    });
    write(`${JSON.stringify(success(result), null, 2)}\n`);
  } finally {
    await client.close();
  }
}

async function dispatch(command: string, args: readonly string[]): Promise<number> {
  if (!commandNames.has(command)) throw new UsageError(`Unknown command: ${command}`);

  if (command === "guide") {
    if (args.length === 1 && args[0] === "--help") {
      write(renderCommandHelp("guide"));
      return 0;
    }
    if (args.length === 0) {
      write(renderAgentHelp());
      return 0;
    }
    if (args.length === 1 && args[0] === "--json") {
      write(`${JSON.stringify(guideEnvelope(), null, 2)}\n`);
      return 0;
    }
    throw new UsageError("guide accepts only --json or --help");
  }

  if (command === "doctor") {
    const mode = noArguments(command, args);
    if (mode === "help") {
      write(renderCommandHelp(command));
      return 0;
    }
    const report = runDoctor();
    write(renderDoctor(report));
    return report.ready ? 0 : 1;
  }

  if (command === "mcp") {
    const mode = noArguments(command, args);
    if (mode === "help") {
      write(renderCommandHelp(command));
      return 0;
    }
    await serveAgentdeskMcp();
    return 0;
  }

  if (command === "js") {
    const options = parseJs(args);
    if (options === "help") {
      write(renderCommandHelp(command));
      return 0;
    }
    await oneShotTool("js", options);
    return 0;
  }

  if (command === "js_reset") {
    const mode = noArguments(command, args);
    if (mode === "help") {
      write(renderCommandHelp(command));
      return 0;
    }
    await oneShotTool("js_reset", {});
    return 0;
  }

  throw new UsageError(`Unknown command: ${command}`);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      write(renderTopHelp());
      return 0;
    }
    if (argv[0] === "--agent-help") {
      if (argv.length !== 1) throw new UsageError("--agent-help takes no arguments");
      write(renderAgentHelp());
      return 0;
    }
    if (argv[0] === "--agent-teaser") {
      if (argv.length !== 1) throw new UsageError("--agent-teaser takes no arguments");
      write(renderTeaser());
      return 0;
    }
    if (argv[0]?.startsWith("--")) throw new UsageError(`Unknown option: ${argv[0]}`);
    return await dispatch(argv[0] ?? "", argv.slice(1));
  } catch (error) {
    if (error instanceof UsageError) {
      writeError(`${error.message}\n`);
      return 2;
    }
    writeError(`agentdesk failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
