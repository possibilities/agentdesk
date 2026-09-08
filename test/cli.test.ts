import { describe, expect, test } from "bun:test";
import { CONTRACT } from "../src/contract.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

const run = (...args: string[]) =>
  Bun.spawnSync(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });

describe("CLI", () => {
  test("renders every help surface from the contract without starting Codex", () => {
    const help = run("--help");
    const agent = run("--agent-help");
    const teaser = run("--agent-teaser");
    expect(help.exitCode).toBe(0);
    expect(agent.exitCode).toBe(0);
    expect(teaser.exitCode).toBe(0);
    expect(teaser.stdout.toString().trim()).toBe(CONTRACT.meta.purpose);
    for (const command of CONTRACT.commands) {
      expect(help.stdout.toString()).toContain(command.name);
      expect(agent.stdout.toString()).toContain(`agentdesk ${command.name}`);
    }
  });

  test("guide --json emits the canonical envelope", () => {
    const result = run("guide", "--json");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      schema_version: 1,
      ok: true,
      error: null,
      data: { contract_version: 1, meta: { name: "agentdesk" } },
    });
  });

  test("usage faults return exit 2 without protocol output", () => {
    const result = run("js", "--timeout-ms", "0");
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("positive integer");
  });
});
