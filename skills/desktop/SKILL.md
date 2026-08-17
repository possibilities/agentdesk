---
name: desktop
description: See and drive the Mac's own GUI with the peekaboo CLI — screenshots of the live screen or any app window, the accessibility tree as data, and real input into native apps (clicking, typing, chords, menus, windows, dialogs, Dock, Spaces, clipboard). Use when a task needs to look at what is on screen ("what's on my screen", "screenshot this app"), verify visible GUI state, or drive a native macOS application. Anything inside a web page — content, forms, signed-in flows — is the browser skill; launching this project's own app to check a change is the run skill.
---

# Desktop — see and drive the macOS GUI

Peekaboo captures pixels, reads the accessibility tree, and delivers real
mouse and keyboard input on this Mac. This skill is the runbook for wielding
its CLI. The screen it works on is the operator's live desk, which makes
etiquette part of the contract, not a nicety.

Verified against Peekaboo 4.2.0. The CLI is self-describing — when this
document and the installed binary disagree, the binary wins; see
[Discovery and drift](#discovery-and-drift).

## Non-negotiables

- **The screen is the operator's live desk.** Captures and accessibility
  reads are free. Input is not: the mouse and keyboard are shared hardware,
  and a foreground takeover races whatever the human is doing. Announce a
  takeover (`notify`, or in-session when they are reading), keep it short,
  and prefer background delivery, which targets an app without stealing
  focus. Ask before destructive or externally visible actions — sending,
  deleting, purchasing, publishing — upstream's own doctrine.
- **Always `--json` in agent loops.** One envelope: `success`, `data`,
  `error{code,message,details}`, `debug_logs`. Mutating commands add
  `effect`: `confirmed | partial | unverifiable | suspected_noop | refused`.
  Read it — only `confirmed` supports a claim of success.
- **Fresh `see` before acting; verify after.** Element IDs (`elem_N`) are
  valid only for the snapshot they came from and the currently visible
  state. One mutation, then `verify` or a fresh `see`, then the next.
- **`verify` replaces sleeps.** It polls native state until predicates are
  stable; `unknown` never implies success.
- **You are the agent.** Never `peekaboo agent` (its own AI loop with its
  own provider keys) and never `peekaboo mcp`/`tools` — this skill plus the
  CLI is the interface. `peekaboo browser` (Chrome control) is off-limits:
  web pages belong to the `browser` skill.
- **A peer agent's terminal pane is not a click target.** Reaching another
  live agent is the `bus` skill's typed delivery, not GUI input.

## Preflight

```bash
peekaboo permissions --json     # Screen Recording + Accessibility required
peekaboo daemon status --json   # on-demand runtime; auto-starts, idle-exits at 300s
```

A missing grant is the human's to fix: hand over the `grantInstructions`
from the permissions output (System Settings paths); `peekaboo permissions
request <kind>` can raise the prompt. The daemon needs no supervision —
`peekaboo daemon stop` is the reset when it misbehaves.

**Bridge evidence failures.** Daemon-routed captures can fail with
`Bridge operation target attribution failed` or "response evidence did not
match…" while accessibility reads keep working. Add `--no-remote` to run
in-process, and `peekaboo daemon stop` for a fresh daemon. Verified on this
machine (2026-08-17, 4.2.0): every daemon-routed `see` capture failed with
those errors; the same commands with `--no-remote` served. Prefer
`--no-remote` for capture work until an upgrade disproves this.

## The observe → act → verify loop

Observe — capture plus an element map in one call:

```bash
peekaboo see --app Ghostty --json --path /tmp/shot.png       # one app window
peekaboo see --mode screen --screen-index 0 --no-remote --json --path /tmp/screen.png
peekaboo see --app Safari --tree --no-screenshot --json      # AX-only, no pixels
```

`see` returns `snapshot_id`, `ui_elements[]` (each
`{id: "elem_7", role, label, bounds, is_actionable}`), `element_count`,
`interactable_count`, and the screenshot paths. `--annotate` draws the
element markers onto the image; `--ocr` adds Vision OCR text. Targets:
`--app <name|bundle-id|PID:n>`, `--pid`, `--window-title`/`--window-index`
(with an app), `--window-id` (from `window list`), or
`--mode screen|window|frontmost|area --region x,y,w,h`.

Act — one mutation, element-targeted when an ID exists:

```bash
peekaboo click --on elem_7 --snapshot 1786978048593-5923 --json
peekaboo click "Save" --app TextEdit --json        # element query by text
peekaboo type "hello" --app TextEdit --json        # --clear to replace; \n \t supported
peekaboo press cmd+s --app TextEdit --json         # chords and key sequences
peekaboo drag --from elem_3 --to elem_9 --json
```

Background delivery is the default and needs a process target; the human
keeps their focus. `--foreground` is for interactions that genuinely need
focus — that is the takeover case in the non-negotiables. Coordinate clicks
(`--at x,y`) are window-relative when an app/window target is given,
global with `--global`; background coordinate clicks require a fresh
exact-window `--snapshot`. `set-value` replaces a field's whole value
directly; `action` invokes a named accessibility action.

Verify — poll the postcondition, never sleep:

```bash
peekaboo verify --app TextEdit --window-exists --json
peekaboo verify --app Safari --on button:Reload --exists --enabled --json
peekaboo verify --app TextEdit --on elem_4 --value-equals "hello" --timeout 5s --json
```

Results are `satisfied`, `unsatisfied`, or `unknown` — treat `unknown` as
not proven, and say so rather than claiming success.

## Reading the system without pixels

Accessibility-backed subcommand trees, all cheap and screenshot-free:

```bash
peekaboo app list --json                 # running applications
peekaboo window list --app Ghostty --json
peekaboo menu list --app Finder --json   # menu bar contents
peekaboo menubar list --json             # status items
peekaboo space list --json               # virtual desktops
peekaboo clipboard get --json
```

`app`, `window`, `menu`, `dock`, `dialog`, and `space` also mutate (launch,
quit, focus, resize, click menu items, dismiss dialogs) — those are input,
with input's etiquette. Avoid overwriting the clipboard unless asked;
`paste` can set, paste, and restore it in one act.

## Captures for the human

A capture the human should see is a file to send, not a description:
`see --path <file>` (add `--annotate` for the marked-up variant, `--retina`
for native resolution), then send the image. `peekaboo capture` handles
screen/window/video-frame capture without element analysis.

## Discovery and drift

The binary teaches itself; prefer asking it over trusting this file:

```bash
peekaboo learn                # the in-binary agent guide, ~1600 lines
peekaboo help <command>       # per-command flags and examples
peekaboo --version
```

After a peekaboo upgrade, re-verify this skill's claims — especially the
bridge-evidence workaround above — before repeating them.

## Sibling skills

| Skill | Reach for it when |
|---|---|
| `browser` | anything inside a web page: content, forms, signed-in flows |
| `run` | launching this project's own app to see a change working |
| `bus` | reaching another live agent on this machine — message, don't click |
| `notify` | announcing an input takeover; reaching the away human |
