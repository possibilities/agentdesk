import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDoctor, runDoctor } from "../src/doctor.ts";

describe("doctor", () => {
  test("reports selections without starting app-server", () => {
    const root = mkdtempSync(join(tmpdir(), "agentdesk-doctor-"));
    const codexHome = join(root, "codex-home");
    const binary = join(root, "codex");
    const plugin = join(
      codexHome,
      "plugins",
      "cache",
      "openai-bundled",
      "unified-computer-use",
      "1.2.3",
      ".codex-plugin",
    );
    mkdirSync(plugin, { recursive: true });
    mkdirSync(join(codexHome, "computer-use", "Codex Computer Use.app"), {
      recursive: true,
    });
    writeFileSync(join(plugin, "plugin.json"), "{}\n");
    writeFileSync(binary, "#!/bin/sh\nprintf 'codex-cli fixture\\n'\n", { mode: 0o755 });

    try {
      const report = runDoctor({
        AGENTDESK_CODEX_HOME: codexHome,
        AGENTDESK_CODEX_BIN: binary,
      });
      expect(report.codexHome).toBe(codexHome);
      expect(report.codexBinary).toBe(binary);
      expect(report.codexVersion).toBe("codex-cli fixture");
      expect(report.pluginDirectory).toContain("1.2.3");
      expect(renderDoctor(report)).toContain("codex-binary");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
