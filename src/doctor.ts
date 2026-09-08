import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveCodexBinary, resolveCodexHome } from "./codex-app-server.ts";

export type DoctorCheck = {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
};

export type DoctorReport = {
  readonly ready: boolean;
  readonly codexHome: string;
  readonly codexBinary: string | null;
  readonly codexVersion: string | null;
  readonly pluginDirectory: string | null;
  readonly nativeApp: string;
  readonly checks: readonly DoctorCheck[];
};

const directoryExists = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const currentPluginDirectory = (codexHome: string): string | null => {
  const root = join(codexHome, "plugins", "cache", "openai-bundled", "unified-computer-use");
  if (!directoryExists(root)) return null;
  const versions = readdirSync(root)
    .filter((name) => directoryExists(join(root, name)))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  const version = versions.find((name) =>
    existsSync(join(root, name, ".codex-plugin", "plugin.json")),
  );
  return version === undefined ? null : join(root, version);
};

const codexVersion = (binary: string): string | null => {
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value === "" ? null : value;
};

export function runDoctor(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DoctorReport {
  const codexHome = resolveCodexHome(env);
  const nativeApp = join(codexHome, "computer-use", "Codex Computer Use.app");
  const pluginDirectory = currentPluginDirectory(codexHome);
  let codexBinary: string | null = null;
  let version: string | null = null;
  let binaryError: string | null = null;
  try {
    codexBinary = resolveCodexBinary(codexHome, env);
    version = codexVersion(codexBinary);
  } catch (error) {
    binaryError = error instanceof Error ? error.message : String(error);
  }

  const checks: DoctorCheck[] = [
    {
      id: "platform",
      ok: process.platform === "darwin",
      detail:
        process.platform === "darwin"
          ? "macOS"
          : `unsupported platform ${process.platform}; Computer Use requires macOS`,
    },
    {
      id: "codex-home",
      ok: directoryExists(codexHome),
      detail: codexHome,
    },
    {
      id: "codex-binary",
      ok: codexBinary !== null && version !== null,
      detail:
        binaryError ?? `${codexBinary ?? "not found"}${version === null ? "" : ` (${version})`}`,
    },
    {
      id: "unified-computer-use",
      ok: pluginDirectory !== null,
      detail: pluginDirectory ?? "openai-bundled/unified-computer-use is not installed",
    },
    {
      id: "native-computer-use",
      ok: directoryExists(nativeApp),
      detail: nativeApp,
    },
  ];

  return {
    ready: checks.every((check) => check.ok),
    codexHome,
    codexBinary,
    codexVersion: version,
    pluginDirectory,
    nativeApp,
    checks,
  };
}

export function renderDoctor(report: DoctorReport): string {
  const checks = report.checks
    .map((check) => `${check.ok ? "ok" : "not ready"}  ${check.id}: ${check.detail}`)
    .join("\n");
  return `Agentdesk ${report.ready ? "is ready" : "is not ready"}\n\n${checks}\n`;
}
