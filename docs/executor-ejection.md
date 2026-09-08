# Executor ejection plan

Agentdesk replaces one Executor edge: the bridge from a harness MCP session to
Codex Computer Use. It does not replace Executor's tool aggregation, authenticated
connections, or service lifecycle.

## Keep the Computer Use substrate

Desktop control is supplied by the installed OpenAI software, not Executor and
not a Codex source checkout:

- the supported `codex app-server` executable;
- the selected `~/.codex` home, including the bundled
  `unified-computer-use` plugin cache;
- `~/.codex/computer-use/Codex Computer Use.app`, which owns the relevant
  macOS Screen Recording and Accessibility identity;
- the Computer Use runtime bundled by the installed ChatGPT/Codex application.

A checkout such as `~/source/openai--codex` is useful for source inspection but
is not part of the runtime path. Removing Executor must preserve the installed
Codex CLI, ChatGPT/Codex application, Codex home, native consent decisions, and
Computer Use app.

## Removal sequence

1. **Land Agentdesk.** Install `agentdesk`, publish `agentdesk mcp` in the
   AgentStart-owned inventory, sync `skills/desktop`, and verify a fresh session
   can list `guide`, `js`, and `js_reset` and make a benign observation.
2. **Replace fleet aggregation.** Give each source-managed stdio MCP its own
   AgentStart inventory entry and prove tools/list and tools/call from fresh
   Claude and Codex sessions. This includes the browser and terminal servers;
   Agentdesk covers only native desktop control.
3. **Rewrite workflow skills.** Remove Executor search/describe and outer-envelope
   assumptions from every affected skill. Route directly to each MCP's semantic
   tool names and preserve that server's structured results.
4. **Migrate authenticated connections.** Prove the replacement for Gmail and
   migrate direct consumers such as Jobsearch. Inventory independent Executor
   integrations and credentials before deciding that its private data is
   disposable.
5. **Remove delivery before the service.** Stop injecting Executor into new
   harness sessions, verify fresh-session parity, then retire its managed service
   and package through their supported uninstall contracts. Do not disrupt
   already-running agent sessions during the cutover.

## Ejection gates

Executor can be removed only after all of these hold:

- Agentdesk preserves schemas, images, structured content, native consent,
  cancellation, and child reaping in a real stdio session.
- Every AgentStart-declared MCP passes direct discovery and a representative
  call without Executor.
- Installed workflow skills no longer direct agents through Executor.
- Gmail/Jobsearch and every intentionally retained authenticated connection work
  through their replacement.
- A fresh Claude session and a fresh Codex session start with no Executor MCP and
  complete representative desktop, browser, terminal, and fleet-tool workflows.
- Independent Executor integrations and data have been reviewed before service,
  cask, or state removal.

AgentStart owns the cross-project inventory, skill rendering, fresh-session
delivery, fleet dependency map, and final service removal. Agentdesk owns only
the first gate and its desktop runbook.
