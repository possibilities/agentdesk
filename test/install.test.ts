import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const script = join(root, "scripts", "install.sh");
const source = join(root, "src", "cli.ts");
const expectedSha = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"])
  .stdout.toString()
  .trim();
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const path of temporaryRoots) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "agentdesk-install-"));
  temporaryRoots.push(base);
  const binDir = join(base, "bin");
  const stateDir = join(base, "state");
  const fakeBin = join(base, "fake-bin");
  mkdirSync(binDir);
  mkdirSync(stateDir);
  mkdirSync(fakeBin);
  const calls = join(base, "calls");
  for (const name of ["bun"]) {
    const executable = join(fakeBin, name);
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf '%s' '${name}' >> '${calls}'\nfor arg in "$@"; do printf ' %s' "$arg" >> '${calls}'; done\nprintf '\\n' >> '${calls}'\n`,
      { mode: 0o755 },
    );
  }
  return {
    base,
    binDir,
    stateDir,
    calls,
    target: join(binDir, "agentdesk"),
    receipt: join(stateDir, "deployed-sha"),
    env: {
      ...process.env,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      AGENTDESK_INSTALL_BIN_DIR: binDir,
      AGENTDESK_INSTALL_STATE_DIR: stateDir,
    },
  };
}

async function run(layout: ReturnType<typeof fixture>, ...args: string[]) {
  const child = Bun.spawn(["bash", script, ...args], {
    cwd: "/tmp",
    env: layout.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function previousCheckout(layout: ReturnType<typeof fixture>, origin: string) {
  const checkout = join(layout.base, "previous-checkout");
  const cli = join(checkout, "src", "cli.ts");
  mkdirSync(join(checkout, "src"), { recursive: true });
  writeFileSync(cli, "#!/usr/bin/env bun\n");
  chmodSync(cli, 0o755);
  git("-C", checkout, "init", "-q");
  git("-C", checkout, "config", "user.name", "Agentdesk Test");
  git("-C", checkout, "config", "user.email", "agentdesk@example.invalid");
  git("-C", checkout, "remote", "add", "origin", origin);
  git("-C", checkout, "add", "src/cli.ts");
  git("-C", checkout, "commit", "-qm", "previous checkout");
  return { cli, sha: git("-C", checkout, "rev-parse", "HEAD") };
}

test("install creates an exact editable link and private receipt", async () => {
  const layout = fixture();
  const result = await run(layout, "--install");
  expect(result.exitCode).toBe(0);
  expect(readlinkSync(layout.target)).toBe(source);
  expect(readFileSync(layout.receipt, "utf8")).toBe(`${expectedSha}\n`);
  expect(lstatSync(layout.receipt).mode & 0o777).toBe(0o600);
  expect(readFileSync(layout.calls, "utf8")).toContain("bun install --frozen-lockfile");
});

test("repeated install atomically replaces the receipt", async () => {
  const layout = fixture();
  expect((await run(layout)).exitCode).toBe(0);
  const firstInode = lstatSync(layout.receipt).ino;
  expect((await run(layout)).exitCode).toBe(0);
  expect(lstatSync(layout.receipt).ino).not.toBe(firstInode);
});

test("check is read-only and does not install dependencies", async () => {
  const layout = fixture();
  const result = await run(layout, "--check");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("bun install --frozen-lockfile");
  expect(existsSync(layout.target)).toBe(false);
  expect(existsSync(layout.receipt)).toBe(false);
  expect(existsSync(layout.calls)).toBe(false);
});

test("uninstall removes only owned artifacts and is idempotent", async () => {
  const layout = fixture();
  expect((await run(layout)).exitCode).toBe(0);
  writeFileSync(join(layout.stateDir, "keep-me"), "keep\n");
  expect((await run(layout, "--uninstall")).exitCode).toBe(0);
  expect(existsSync(layout.target)).toBe(false);
  expect(existsSync(layout.receipt)).toBe(false);
  expect(readFileSync(join(layout.stateDir, "keep-me"), "utf8")).toBe("keep\n");
  expect((await run(layout, "--uninstall")).exitCode).toBe(0);
});

test("installer refuses foreign command paths", async () => {
  const layout = fixture();
  writeFileSync(layout.target, "foreign\n");
  const result = await run(layout);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Refusing foreign command path");
  expect(readFileSync(layout.target, "utf8")).toBe("foreign\n");
});

test("installer refuses a previous checkout with a foreign origin", async () => {
  const layout = fixture();
  const previous = previousCheckout(layout, "https://example.com/possibilities/agentdesk.git");
  symlinkSync(previous.cli, layout.target);
  const result = await run(layout);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("foreign origin");
  expect(readlinkSync(layout.target)).toBe(previous.cli);
});

test("installer migrates an exact previous checkout using canonical SSH origin", async () => {
  const layout = fixture();
  const previous = previousCheckout(layout, "git@github.com:possibilities/agentdesk.git");
  symlinkSync(previous.cli, layout.target);
  writeFileSync(layout.receipt, `${previous.sha}\n`, { mode: 0o600 });
  const result = await run(layout);
  expect(result.exitCode).toBe(0);
  expect(readlinkSync(layout.target)).toBe(source);
  expect(readFileSync(layout.receipt, "utf8")).toBe(`${expectedSha}\n`);
});

test("installer refuses malformed and permissive receipts", async () => {
  for (const mode of [0o600, 0o644]) {
    const layout = fixture();
    symlinkSync(source, layout.target);
    writeFileSync(layout.receipt, mode === 0o600 ? "not-a-sha\n" : `${expectedSha}\n`, { mode });
    const result = await run(layout);
    expect(result.exitCode).toBe(1);
    expect(existsSync(layout.target)).toBe(true);
  }
});

test("uninstall refuses a foreign occupant without deleting the receipt", async () => {
  const layout = fixture();
  expect((await run(layout)).exitCode).toBe(0);
  rmSync(layout.target);
  writeFileSync(layout.target, "foreign\n");
  const result = await run(layout, "--uninstall");
  expect(result.exitCode).toBe(1);
  expect(existsSync(layout.receipt)).toBe(true);
});

test("help works and invalid argument shapes are rejected", async () => {
  const layout = fixture();
  expect((await run(layout, "--help")).exitCode).toBe(0);
  expect((await run(layout, "--unknown")).exitCode).toBe(2);
  expect((await run(layout, "--check", "extra")).exitCode).toBe(2);
  expect(existsSync(layout.target)).toBe(false);
});
