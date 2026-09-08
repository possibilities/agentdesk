# Input and recovery

The Computer Use API is versioned with the installed Codex/ChatGPT desktop
runtime. Read the documentation returned by the first `js` call and prefer it
over examples here.

## Choose the least ambiguous action

- Select an application with `cua.getApp(nameOrBundleId)` and retain the
  returned handle in the persistent session.
- Observe immediately before acting. Prefer a current accessibility element
  reference over screen coordinates.
- Use direct value/action APIs when the returned documentation says the target
  supports them. Use keyboard or pointer input only when direct interaction is
  unavailable.
- Ground coordinates in the latest screenshot. Re-observe after window
  movement, resizing, navigation, or any uncertain state change.
- Paste is appropriate for long or multiline content only after focus and the
  destination are verified. Do not inspect or retain unrelated clipboard data.

## Preserve the real result

The `js` tool may return multiple text and image content blocks plus structured
content. Treat every block as part of one result. Inspect image content with the
harness's image viewer; do not fetch private captures through the web. Values
explicitly added with `nodeRepl.write` are text/data, while
`nodeRepl.emitImage` produces an image block.

Tool-level failure and transport failure differ. Preserve the original message,
structured content, and error marker. Agentdesk adds its own JSON error envelope
only when its bridge or Codex child fails before the upstream tool can answer.

## Recover without repeating uncertain effects

- An application-consent request is an MCP elicitation. Answer only the scope
  the user authorized. Decline or cancellation is final for that attempt; do
  not reroute around it.
- Cancellation or loss of the app-server child does not prove the GUI action
  was undone. Start a fresh session, observe, and retry only if the observation
  proves the action did not happen.
- If an app display name fails, use the inventory returned by `cua.getState()`
  to resolve the same app's bundle identifier. Do not choose a similarly named
  app by guesswork.
- A blank screenshot, missing accessibility tree, wrong window, or absent macOS
  grant is a limitation to resolve or report. Tool registration alone does not
  prove normal capture or input.
- Use `js_reset` only to discard a corrupted or deliberately finished
  JavaScript session. It does not close apps, tabs, or undo actions.

The surface does not imply arbitrary app launch/quit, window management,
clipboard reads, shell execution, or video recording. Use only capabilities the
returned documentation actually exposes.
