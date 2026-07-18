#!/bin/sh
# aigent-OS remote installer (macOS/Linux)
# Fetches aigent-OS onto disk. Run via:
#   curl -fsSL https://tools.theaigent.xyz/os/install | sh
#
# This script only clones/updates the aigent-OS checkout. It does not run
# the framework installer itself -- that stays a separate, inspectable local
# step (bash install.sh), per docs/install-security.md's "no remote-fetch-
# and-execute" guarantee for the framework installer.
#
# POSIX sh. No bashisms, no sudo, no interactive prompts. Safe to re-run.
#
# Everything below is wrapped in main() and only invoked via the literal
# "main \"$@\"" on the last line, so a truncated curl|sh stream (connection
# drop mid-download) either fails as an incomplete function definition or,
# if it happens to cut off right after main() closes but before the call
# line is reached, simply defines the function and does nothing. Either
# way a partial script never half-executes. Mirrors the same function +
# single-invocation shape used in web-install.ps1.

set -eu

REPO_URL="https://github.com/wrg32786/aigent-os.git"
REPO_MATCH="wrg32786/aigent-os"

fail() {
  printf '\n[aigent-OS installer] ERROR: %s\n\n' "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

dir_is_empty() {
  [ -z "$(ls -A "$1" 2>/dev/null)" ]
}

is_our_repo() {
  git -C "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  remote_url="$(git -C "$1" remote get-url origin 2>/dev/null)" || return 1
  # Exact match only (not a substring test): the local git config at $1 is
  # attacker-controlled input. A substring test like *"$REPO_MATCH"* would
  # accept any origin that merely CONTAINS "wrg32786/aigent-os" somewhere
  # (a redirect URL, a query string, a lookalike subdomain) without actually
  # being our repo. Normalize a trailing .git on either side, nothing else.
  case "$remote_url" in
    "$REPO_URL" | "${REPO_URL%.git}") return 0 ;;
    *) return 1 ;;
  esac
}

main() {
  if ! command_exists git; then
    printf '\n[aigent-OS installer] ERROR: git was not found on your PATH.\n\n'
    printf 'git is required to download aigent-OS. Install it, then re-run this command:\n'
    printf '  macOS:         xcode-select --install   (or: brew install git)\n'
    printf '  Debian/Ubuntu: sudo apt-get install git\n'
    printf '  Fedora:        sudo dnf install git\n'
    printf '  Other:         https://git-scm.com/downloads\n\n'
    exit 1
  fi

  if ! command_exists claude; then
    printf '\n[aigent-OS installer] ERROR: Claude Code was not found on your PATH.\n\n'
    printf 'aigent-OS runs inside Claude Code, so it needs to be installed first:\n'
    printf '  npm install -g @anthropic-ai/claude-code\n\n'
    printf 'No Node.js/npm, or want another install option? See https://claude.ai/code\n'
    printf 'Then re-run this command.\n\n'
    exit 1
  fi

  # If $HOME is unset (rare -- some minimal/containerized shells), this
  # collapses to the absolute path "/aigent-os". git will surface a clear
  # permission or not-found error there rather than silently doing anything
  # unsafe, but it will not be the directory the user expected.
  TARGET_DIR="${AIGENT_OS_DIR:-$HOME/aigent-os}"

  # A directory starting with "-" would be misread as an option by any
  # command that takes it as a positional argument (e.g. git clone). Reject
  # it outright rather than relying solely on the "--" below.
  case "$TARGET_DIR" in
    -*) fail "AIGENT_OS_DIR must not start with '-' (got: $TARGET_DIR).
Use an absolute path instead, e.g. AIGENT_OS_DIR=\"\$HOME/aigent-os\"." ;;
  esac

  if [ -e "$TARGET_DIR" ] && [ ! -d "$TARGET_DIR" ]; then
    fail "$TARGET_DIR already exists and is a file, not a directory.
Set AIGENT_OS_DIR to a different path and re-run this command."
  fi

  IS_OUR_REPO=0
  if [ -d "$TARGET_DIR" ] && ! dir_is_empty "$TARGET_DIR"; then
    if is_our_repo "$TARGET_DIR"; then
      IS_OUR_REPO=1
    else
      fail "$TARGET_DIR already exists and is not an aigent-OS checkout.
Nothing was changed. Point somewhere else with:
  AIGENT_OS_DIR=/path/you/want curl -fsSL https://tools.theaigent.xyz/os/install | sh"
    fi
  fi

  if [ "$IS_OUR_REPO" -eq 1 ]; then
    printf 'Existing aigent-OS checkout found at %s. Pulling latest...\n' "$TARGET_DIR"
    # Pin origin to the canonical URL before pulling. The gate check above
    # decides whether this looks like our checkout, but the actual fetch
    # never relies on trusting whatever the local git config had configured
    # -- it always pulls from the URL this script itself hardcodes.
    if ! git -C "$TARGET_DIR" remote set-url origin "$REPO_URL"; then
      fail "could not set the origin remote in $TARGET_DIR. Resolve manually, then re-run."
    fi
    if ! git -C "$TARGET_DIR" pull --ff-only; then
      fail "git pull failed in $TARGET_DIR.
Check for local changes or a diverged branch, resolve manually, then re-run."
    fi
  else
    printf 'Cloning aigent-OS into %s ...\n' "$TARGET_DIR"
    if ! git clone -- "$REPO_URL" "$TARGET_DIR"; then
      fail "git clone failed. Check your network connection and try again."
    fi
  fi

  printf '\naigent-OS is ready at: %s\n\n' "$TARGET_DIR"
  printf 'Next steps:\n'
  printf '  1. cd %s\n' "$TARGET_DIR"
  printf '  2. bash install.sh\n'
  printf '  3. Open Claude Code in that directory (or run: claude)\n'
  printf '     First time in this directory, run /start to complete setup.\n\n'
}

main "$@"
