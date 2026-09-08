# Agentdesk agent guidance

## What this repository is

Agentdesk is the fleet-owned stdio MCP bridge to Codex Computer Use. It owns:

- `agentdesk mcp`, a transparent proxy for the current Codex
  `unified-computer-use` / `cua_repl` tools;
- the fleet CLI contract and a read-only `doctor`;
- `scripts/install.sh`, the hardened editable-command installer and retained
  Peekaboo retirement contract;
- `skills/desktop/`, the runbook shipped by AgentStart's normal fleet skill
  scan.

AgentStart (`~/code/agentstart`) owns the one checked-in MCP inventory, renders
it for harnesses, invokes this checkout's installer, and ships its skill. Do not
add another registry, discovery scan, HTTP gateway, service, or harness config
writer here.

## Runtime boundaries

- Use the supported `codex app-server` stdio JSON-RPC interface. One Agentdesk
  MCP process owns and reaps one child and one ephemeral thread.
- Proxy the installed `cua_repl` catalog. Do not vendor `@oai/sky`, the native
  service, plugin files, or a copied tool description.
- Preserve downstream input schemas, descriptions, structured content, image
  content, errors, and elicitation metadata. Application consent is a user
  decision: forward it and fail closed when the MCP client cannot answer.
- Serialize calls because the CUA JavaScript session is persistent. Propagate
  cancellation by stopping the owned child and never retry an uncertain GUI
  action automatically.
- Do not call a bare managed `codex` shim recursively. Runtime resolution is
  explicit and inspectable, and the selected Codex home is passed only to the
  child. Never modify global Codex auth or config.
- CLI help and install checks do not start app-server. The MCP server starts it
  lazily for discovery or a call.

## Conventions and verification

- `agentdesk guide --json` is the one fleet agent contract. `--help`,
  `--agent-help`, and `--agent-teaser` render it; MCP names are unprefixed.
- Use Bun with exact dependency pins. `bun run check` is the repository gate.
- Tests must include a real stdio MCP handshake, app-server protocol fixture,
  child cleanup/cancellation, elicitation pass-through, image preservation,
  and installer refusal/idempotence cases. A live smoke may observe the
  current CUA surface but must not mutate another application.
- The installer is rerunnable, uses frozen dependencies, publishes an editable
  `~/.local/bin/agentdesk` link plus a private SHA receipt, and removes only
  ownership-proved historical Peekaboo artifacts. It never alters TCC grants.

## After changing this repository

- Run `bun run check` and the narrow live MCP smoke described in the README.
- Run `scripts/install.sh --install`, then `scripts/install.sh --check`.
- Ask AgentStart to validate this checkout's guide against
  `config/agent-contract/schema.json` and to converge its MCP inventory/skills.
- A cross-project call-edge change updates
  `~/code/agentstart/skills/fleet/MAP.md` in the AgentStart-owned change.

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship into AgentStart's fixed private
  fleet resources (`~/code/agentstart/scripts/sync-skills`, run six-hourly
  by the scheduled updater). AgentLaunch loads them into every managed
  session: Claude Code exposes `/agent:<name>`, and Codex uses
  `$agent:<name>`. A SKILL.md edit is live within
  six hours, or on demand by running that script. Whether a new skill earns a TOOLS.md
  advertisement line is a deliberate decision —
  `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, maintain, story, the resource
  skills — is `~/code/agentguidance`; tool-specific runbooks stay here.
