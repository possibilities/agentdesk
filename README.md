# Agentdesk

Agentdesk makes Codex Computer Use available as a standalone stdio MCP server.
It is the small bridge that lets any fleet harness use the same signed native
runtime as Codex without depending on Executor.

```json
{
  "transport": "stdio",
  "command": "agentdesk",
  "args": ["mcp"]
}
```

The server starts one private `codex app-server` child per MCP session and
proxies the current `cua_repl` tools (`js` and `js_reset`) without replacing
their schemas, descriptions, structured data, or image blocks. It starts no
model turn and performs no inference. Application-consent requests are relayed
as MCP elicitations and are never accepted automatically.

## Install

Requirements are macOS, Bun, and a current Codex/ChatGPT desktop installation
with the bundled `unified-computer-use` plugin.

```bash
scripts/install.sh --install
agentdesk doctor
```

Installation creates an editable `~/.local/bin/agentdesk` link and a private
deployment receipt. It does not install or modify Codex, change Codex
authentication or configuration, grant macOS permissions, or start a resident
service.

AgentStart owns fleet discovery: it publishes the `agentdesk mcp` entry in its
single MCP inventory and discovers `skills/desktop/` through the normal
`~/code/agent*` skill scan.

## Runtime selection

Agentdesk deliberately does not invoke a managed `codex` shim from `PATH`.
It selects:

1. the absolute path in `AGENTDESK_CODEX_BIN`, when set;
2. `~/.codex/packages/standalone/current/bin/codex`;
3. `/Applications/ChatGPT.app/Contents/Resources/codex`.

`AGENTDESK_CODEX_HOME` selects the state/plugin home; it defaults to
`~/.codex` and does not inherit an ambient `CODEX_HOME`. The selected value is
passed only to the owned app-server child. `agentdesk doctor` reports both
selections and the native Computer Use/plugin prerequisites.

The child uses an ephemeral app-server thread with `approvalPolicy` set to
`on-request`. Calls are serialized because the JavaScript runtime is
persistent. Cancellation closes the child and never retries an uncertain GUI
action. EOF and termination reap the child.

The app-server protocol is documented by
[OpenAI](https://learn.chatgpt.com/docs/app-server); Agentdesk uses its supported
stdio JSON-RPC transport and `mcpServer/tool/call` API.

## Commands

```bash
agentdesk --help
agentdesk guide --json
agentdesk --agent-help
agentdesk --agent-teaser
agentdesk doctor
agentdesk mcp
```

The machine-readable guide is the source for all help renders and for the
MCP-facing `guide` tool.

See [Executor ejection plan](docs/executor-ejection.md) for the substrate that
must remain installed and the fleet-wide gates required before Executor itself
can be removed.
