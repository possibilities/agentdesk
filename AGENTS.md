# Agentdesk agent guidance

## What this repository is

Agentdesk makes the Mac's own GUI a fleet capability — seen, read, and
driven by agent sessions. It owns two things and nothing else:

- `scripts/install.sh` — the installation contract for peekaboo
  (openclaw/Peekaboo): install or upgrade the CLI from its official
  Homebrew tap (`steipete/tap`), then gate on the capability serving —
  the required TCC permissions granted and a screen capture delivered.
- `skills/desktop/` — the source of the `desktop` agent skill, the runbook
  that teaches agents to wield peekaboo: the observe → act → verify loop,
  input etiquette on a live desk, and the operational failure modes. The
  `skills/<name>/` layout is the convention AgentStart's per-checkout skill
  scan discovers.

AgentStart (`~/code/agentstart`) owns AI-stack installation and invokes
both: the installer through this repository's `scripts/install.sh
--install` (a direct block beside agentchats' — the `install-agent-clis`
loop is for checkouts that ship their own CLIs, not wrappers over
third-party binaries), the skill through the `agent*` checkout skill scan
(`scripts/sync-skills`). Do not add a second installation or
synchronization path here.

## Conventions

- The installer follows the fleet's helper style: bash,
  `set -euo pipefail`, a `die` helper, `--check` prints the plan without
  changing the system. A machine without this checkout is a skip inside
  AgentStart, not a failure; a present checkout that fails to install is a
  real error and propagates.
- peekaboo tracks the latest tap release deliberately, like every
  third-party binary the fleet installs; nothing digest-locks it.
- TCC grants (Screen Recording, Accessibility) are the human's act. The
  installer verifies and refuses with the exact System Settings steps; it
  never grants. The capture gate runs `--no-remote` deliberately: it
  proves the grant and the capture engine without betting the install on
  the on-demand daemon's bridge attribution, which has its own failure
  modes the skill documents.
- `skills/desktop/SKILL.md` documents the CLI as installed, grounded in
  real command output. After a peekaboo upgrade changes behavior, reverify
  the skill's claims against the live CLI (`peekaboo learn`,
  `peekaboo help <command>`) before editing prose — especially the
  bridge-evidence workaround, which is dated and machine-verified.
- The harness is the agent: `peekaboo agent` (its own AI loop),
  `peekaboo mcp` (MCP server registration), and `peekaboo browser`
  (Chrome control) stay unused. Web pages belong to agentweb's `browser`
  skill.
- Upstream reference is https://peekaboo.sh and the in-binary
  `peekaboo learn`; clone openclaw/Peekaboo into `~/src` only when source
  is genuinely needed.

## After changing this repository

- Installer changes: rerun `scripts/install.sh --install` here, then
  AgentStart's convergence check
  (`~/code/agentstart/scripts/install.sh --install`).
- Skill changes: rerun AgentStart's private plugin scan
  (`~/code/agentstart/scripts/sync-skills`), then confirm the installed plugin
  copy matches this checkout.

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship through AgentStart's private core plugin
  (`~/code/agentstart/scripts/sync-skills`, run six-hourly by the scheduled
  updater): Claude Code and Codex expose them under the `agentstart-core`
  plugin namespace, while Pi uses the plain skill name. A SKILL.md edit is
  live within six hours, or on demand by running that script. Whether a new
  skill earns a TOOLS.md advertisement line is a deliberate decision —
  `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, story, the resource skills — is
  `~/code/agentguidance`; tool-specific runbooks stay here.
