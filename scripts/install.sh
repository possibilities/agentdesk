#!/bin/bash

set -euo pipefail

# Agentdesk installer: installs peekaboo (openclaw/Peekaboo) from its official
# Homebrew tap so the Mac's own GUI — pixels, the accessibility tree, real
# input — is an agent capability, then gates on that capability serving.
#
# AgentStart invokes this from scripts/install.sh with --install. The script is
# fix-forward and safe to rerun: the binary converges on the latest tap release
# and the gates only ever verify, never grant.

tap=steipete/tap
formula=peekaboo

usage() {
    cat <<'EOF'
Usage: scripts/install.sh --install | --check

Install peekaboo (the macOS GUI capture and automation CLI) from its official
Homebrew tap and verify the capability serves: the required TCC permissions
granted and a screen capture delivered.

Options:
  --install  Install or upgrade peekaboo, verify permissions and a capture
  --check    Print the installation plan without changing the system
EOF
}

die() {
    printf 'Agentdesk installer: %s\n' "$*" >&2
    exit 1
}

case "${1:-}" in
    --check)
        cat <<EOF
peekaboo (macOS GUI capture and automation):
  brew tap + trust $tap, then install or upgrade $formula
  peekaboo permissions --json   # verify Screen Recording + Accessibility; TCC grants are the human's act, so missing ones refuse with the System Settings steps
  peekaboo see --mode screen --no-remote --json   # the served-capture gate, in-process so it proves the grant and the engine, not the daemon's bridge attribution
EOF
        exit 0
        ;;
    --install)
        ;;
    -h|--help)
        usage
        exit 0
        ;;
    *)
        usage >&2
        exit 64
        ;;
esac
[ "$#" -eq 1 ] || {
    usage >&2
    exit 64
}

[ "$(uname -s)" = Darwin ] || die "macOS is required"
[ "$(id -u)" -ne 0 ] || die "run as the target user, not root"
command -v brew >/dev/null 2>&1 || die "Homebrew is required"
[ -x /usr/bin/jq ] || die "/usr/bin/jq is required"

export HOMEBREW_NO_ASK=1

# Latest from the official tap, deliberately, like every third-party binary
# the fleet installs: nothing digest-locks peekaboo, so the tap's newest
# release is the contract.
printf 'Installing or upgrading peekaboo from %s.\n' "$tap"
brew tap "$tap"
brew trust --tap "$tap"
if brew list --formula --versions "$formula" >/dev/null 2>&1; then
    brew upgrade --formula --yes "$tap/$formula"
else
    brew install --formula --yes "$tap/$formula"
fi
command -v peekaboo >/dev/null 2>&1 || die "peekaboo did not land on PATH"
printf '%s\n' "$(peekaboo --version)"

# TCC grants are the human's act: a script can verify them, never make them.
# The gate is strict because peekaboo without them is a no-op — grant in
# System Settings, then rerun.
printf 'Verifying peekaboo permissions.\n'
permissions_json=$(peekaboo permissions --json 2>/dev/null) \
    || die "peekaboo permissions did not answer; run: peekaboo permissions"
printf '%s' "$permissions_json" | /usr/bin/jq -e '.success == true' >/dev/null \
    || die "peekaboo permissions reported failure; run: peekaboo permissions"
missing=$(
    printf '%s' "$permissions_json" \
        | /usr/bin/jq -r '.data.permissions[]
            | select(.isRequired and (.isGranted | not))
            | "  \(.name) — \(.grantInstructions)"'
)
if [ -n "$missing" ]; then
    printf 'Required macOS permissions are not granted to this terminal:\n%s\n' \
        "$missing" >&2
    die "grant the permissions above in System Settings, then rerun"
fi

# A served capture is the promise, so a capture is the gate. --no-remote pins
# the probe in-process: it proves the TCC grant and the capture engine without
# also betting the install on the on-demand daemon's bridge attribution, which
# has its own failure modes the desktop skill documents.
printf 'Verifying a screen capture serves.\n'
gate_dir=$(mktemp -d -t agentdesk-gate)
trap 'rm -rf "$gate_dir"' EXIT
gate_png="$gate_dir/capture.png"
peekaboo see --mode screen --screen-index 0 --no-remote --json --path "$gate_png" \
    | /usr/bin/jq -e '.success == true' >/dev/null \
    || die "screen capture failed; run: peekaboo see --mode screen --no-remote"
[ -s "$gate_png" ] \
    || die "screen capture delivered no image; run: peekaboo see --mode screen --no-remote"

printf 'peekaboo is installed and the desktop capability serves.\n'
