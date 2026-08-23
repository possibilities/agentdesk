# Agentdesk

The Mac's own GUI as an agent capability: screenshots, the accessibility
tree, and real input — clicking, typing, menus, windows — through
[peekaboo](https://peekaboo.sh) (openclaw/Peekaboo).

- `scripts/install.sh --install` installs peekaboo from its official
  Homebrew tap and verifies the capability serves: the required TCC
  permissions granted and a screen capture delivered. `--check` prints the
  plan without changing the system.
- `skills/desktop/` is the `desktop` agent skill — the runbook agent
  sessions load to wield peekaboo well.

Part of the agent* fleet under `~/code`: AgentStart
(`~/code/agentstart`) invokes the installer and ships the skill through its
default `common` capability-pack scan.
