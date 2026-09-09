# AgentDesk context

**Proxy** — The AgentDesk stdio MCP process forwarding the installed CUA tool
catalog and calls through Codex app-server. It preserves the downstream contract
instead of authoring a second Computer Use API.
_Avoid_: native runtime, service, tool catalog owner.

**Owned child** — The one lazily started app-server process and ephemeral thread
owned by a Proxy. Cancellation, EOF and termination close and reap it; neither
discovery nor a call creates an independent resident service.
_Avoid_: shared server, model session.

**REPL session** — The persistent CUA JavaScript state reached through the Owned
child. Calls are serialized because a later call can depend on earlier bindings;
reset or child termination ends that continuity.
_Avoid_: stateless request, shell.

**Discovery** — Reading the installed `cua_repl` tool definitions through the
Owned child. The returned schemas, descriptions and content types remain the
native runtime's contract rather than a vendored AgentDesk copy.
_Avoid_: registry synchronization, inference.

**Consent** — An application-access decision requested by the native runtime
and relayed as MCP elicitation to the human. An unsupported or malformed answer
is cancellation; discovery and tool availability do not grant consent.
_Avoid_: automatic approval, TCC grant.

**Cancellation** — Ending the active call by stopping the Owned child. An
uncertain GUI action is never automatically retried because it may already
have changed the application.
_Avoid_: rollback, safe retry.
