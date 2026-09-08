# ADR 0001: Proxy Codex Computer Use through app-server

Status: accepted, 2026-09-08

## Context

Executor exposed Computer Use by launching `codex app-server` and projecting a
legacy `node_repl` / `@oai/sky` surface as eleven typed tools. Current Codex
ships `unified-computer-use` as the `cua_repl` MCP server. Its `js` tool returns
the runtime's current API documentation and can emit native MCP image blocks.
Calling the proprietary service or bundled MCP launcher outside a Codex host
session is unsupported and can fail process authentication.

## Decision

Agentdesk is a transparent stdio MCP proxy for app-server's `cua_repl` server.
It forwards `js` and `js_reset` definitions and results rather than copying the
older Sky surface. One MCP process owns one lazily started app-server child and
one ephemeral thread; calls are serialized because the REPL is persistent.

Initialization advertises OpenAI form elicitation support, and the thread uses
`approvalPolicy: "on-request"`. Downstream `mcpServer/elicitation/request`
messages are related to the active upstream tool call. Unsupported or malformed
answers become cancellation, never approval. Upstream cancellation closes the
child and is not retried.

The default binary is the native standalone Codex installation, falling back to
the ChatGPT desktop resource. Agentdesk does not resolve a managed shim from
`PATH`, alter authentication, write Codex configuration, vendor the plugin, or
run a model turn.

## Consequences

Agentdesk tracks the installed native tool contract automatically and preserves
new content types without repository changes. It requires a current
Codex/ChatGPT desktop installation and an MCP client capable of answering
elicitation for consent-requiring calls. AgentStart remains the sole inventory
and harness-delivery owner.
