import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildContract,
  guideEnvelope,
  renderAgentHelp,
  renderCommandHelp,
  renderTeaser,
  renderTopHelp,
} from "../src/contract.ts";

const CONTRACT = buildContract();

describe("fleet agent contract", () => {
  test("declares the requested command audiences and mutation behavior", () => {
    const commands = Object.fromEntries(
      CONTRACT.commands.map((command) => [command.name, command]),
    );

    expect(commands.guide).toMatchObject({ audience: "agent", mutates: false });
    expect(commands.doctor).toMatchObject({ audience: "operator", mutates: false });
    expect(commands.mcp).toMatchObject({ audience: "internal", mutates: true, blocking: true });
    expect(commands.js).toMatchObject({ audience: "agent", mutates: true });
    expect(commands.js_reset).toMatchObject({ audience: "agent", mutates: true });
  });

  test("exposes exactly guide, js, and js_reset as MCP tools", () => {
    const exposed = CONTRACT.commands
      .filter((command) => command.audience === "agent")
      .map((command) => command.name);
    expect(exposed).toEqual(["guide", "js", "js_reset"]);
  });

  test("wraps guide in the standard JSON envelope", () => {
    expect(guideEnvelope(CONTRACT)).toEqual({
      schema_version: 1,
      ok: true,
      error: null,
      data: CONTRACT,
    });
  });

  test("describes js inputs without losing requiredness or bounds", () => {
    const js = CONTRACT.commands.find((command) => command.name === "js");
    expect(js?.arguments).toEqual([
      expect.objectContaining({ name: "--code", type: "string", required: true }),
      expect.objectContaining({ name: "--timeout-ms", type: "integer", minimum: 1 }),
      expect.objectContaining({ name: "--title", type: "string" }),
    ]);
  });

  test("derives read-only paths from leaves", () => {
    const derived = CONTRACT.commands
      .filter((command) => command.mutates === false)
      .map((command) => command.name);
    expect(CONTRACT.concepts.read_only_commands).toEqual(derived);
    expect(derived).toEqual(["guide", "doctor"]);
  });

  test("all help surfaces render the authored contract", () => {
    expect(renderTeaser(CONTRACT).trim()).toBe(CONTRACT.meta.purpose);

    const top = renderTopHelp(CONTRACT);
    const agent = renderAgentHelp(CONTRACT);
    for (const command of CONTRACT.commands) {
      expect(top).toContain(command.name);
      expect(agent).toContain(`${CONTRACT.meta.name} ${command.name}`);
      expect(renderCommandHelp(command.name, CONTRACT)).toContain(command.summary);
    }
    expect(agent).toContain(CONTRACT.guidance);
    expect(renderCommandHelp("js", CONTRACT)).toContain("Minimum 1");
  });
});

const VALIDATOR = join(homedir(), "code", "agentstart", "scripts", "validate-agent-contract.ts");

test.if(existsSync(VALIDATOR))("AgentStart's validator accepts the contract", () => {
  const envelope = {
    schema_version: 1,
    ok: true,
    error: null,
    data: CONTRACT,
  };
  const result = Bun.spawnSync(["bun", VALIDATOR, "--file", "/dev/stdin"], {
    stdin: Buffer.from(`${JSON.stringify(envelope)}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toContain("conforms to version 1");
  expect(result.exitCode).toBe(0);
});
