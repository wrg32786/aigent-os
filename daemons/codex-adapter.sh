#!/usr/bin/env bash
# codex-adapter.sh -- routes ONE bounded, mechanical task to the Codex CLI
# (https://developers.openai.com/codex) as a non-Claude executor.
#
# This is the smallest honest slice of "vendor-agnostic execution": a real,
# runnable path for a single task class (a bounded, mechanical change to a
# working directory), not a general multi-LLM router. Extension points for
# routing task CLASSES to different executors, or wiring additional CLIs
# (Gemini CLI, opencode, etc.) behind the same interface, are noted below --
# not built here.
#
# Config surface (generic -- no local paths, no hostnames):
#   AIGENT_CODEX_BIN   Path or name of the Codex CLI binary. Default: codex
#
# Same review-before-merge discipline as any other agent-produced diff: this
# script NEVER commits or pushes. It runs the task, then writes the raw
# output and (if the target is a git repo) a working-tree diff to
# .aigent/codex-runs/<timestamp>/ for a human or the calling Claude to
# review before anything is merged.
set -u

usage() {
  cat <<'USAGE'
Usage: codex-adapter.sh "<task prompt>" [--dir <path>] [--sandbox <mode>]

  <task prompt>   Required. A bounded, mechanical task description -- the
                  kind of thing a review gate can check mechanically
                  (e.g. "add a .gitignore entry for *.tmp files",
                  "rename every occurrence of oldFn to newFn in src/").
                  Not for open-ended strategic work -- that stays with
                  the operating Claude session.
  --dir <path>    Working directory the task runs in. Default: current
                  directory.
  --sandbox <mode> Passed through to `codex exec --sandbox`. Default:
                  workspace-write (Codex may read/write inside --dir, but
                  not touch the wider filesystem or network). See
                  `codex exec --help` for the full mode list.

Env:
  AIGENT_CODEX_BIN  Path or name of the Codex CLI binary. Default: codex

Example:
  AIGENT_CODEX_BIN=codex bash daemons/codex-adapter.sh \
    "Add a .gitignore entry for *.tmp files" --dir .
USAGE
}

unsafeRawOperatorTask() {
  local value="$1" reason="$2"
  [[ -n "$reason" ]] || {
    echo "codex-adapter: unsafeRawOperatorTask requires a reason." >&2
    return 2
  }
  UNSAFE_RAW_OPERATOR_TASK="$value"
}

TASK=""
DIR="."
SANDBOX="workspace-write"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      DIR="${2:-}"; shift 2 ;;
    --sandbox)
      SANDBOX="${2:-}"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      if [[ -z "$TASK" ]]; then TASK="$1"; shift; else
        echo "codex-adapter: unexpected argument: $1" >&2; usage >&2; exit 2
      fi ;;
  esac
done

if [[ -z "$TASK" ]]; then
  echo "codex-adapter: a task prompt is required." >&2
  usage >&2
  exit 2
fi

unsafeRawOperatorTask \
  "$TASK" \
  "the operator-supplied task is intentionally the complete multiline Codex prompt" \
  || exit $?

if [[ ! -d "$DIR" ]]; then
  echo "codex-adapter: --dir '$DIR' does not exist." >&2
  exit 2
fi

CODEX_BIN="${AIGENT_CODEX_BIN:-codex}"
if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
  echo "codex-adapter: Codex CLI not found ('$CODEX_BIN'). Install it (https://developers.openai.com/codex)" \
       "or set AIGENT_CODEX_BIN to its path." >&2
  exit 127
fi

DIR="$(cd "$DIR" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$DIR/.aigent/codex-runs/$STAMP"
mkdir -p "$RUN_DIR" 2>/dev/null || {
  echo "codex-adapter: could not create review directory $RUN_DIR" >&2
  exit 1
}

OUTPUT_LOG="$RUN_DIR/output.log"
{
  echo "task: $UNSAFE_RAW_OPERATOR_TASK"
  echo "dir: $DIR"
  echo "sandbox: $SANDBOX"
  echo "---"
} > "$OUTPUT_LOG"

IS_GIT_REPO=0
if git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  IS_GIT_REPO=1
fi

(
  cd "$DIR" && "$CODEX_BIN" exec --sandbox "$SANDBOX" --skip-git-repo-check "$UNSAFE_RAW_OPERATOR_TASK"
) >>"$OUTPUT_LOG" 2>&1
CODEX_STATUS=$?

REVIEW_DIFF="$RUN_DIR/review.diff"
if [[ "$IS_GIT_REPO" -eq 1 ]]; then
  # Tracked-file changes first...
  git -C "$DIR" diff --no-color -- . > "$REVIEW_DIFF" 2>/dev/null || true
  # ...then a synthetic diff per untracked file (plain `git diff` never shows
  # these, and a task that adds new files is a common, honest outcome) --
  # --no-index never touches the index, so nothing here disturbs any staging
  # the operator already had in progress.
  while IFS= read -r -d '' f; do
    git -C "$DIR" diff --no-color --no-index -- /dev/null "$f" >> "$REVIEW_DIFF" 2>/dev/null || true
  done < <(git -C "$DIR" ls-files --others --exclude-standard -z 2>/dev/null)
  git -C "$DIR" status --porcelain -- . >> "$RUN_DIR/status.txt" 2>/dev/null || true
fi

echo "codex-adapter: run complete (exit $CODEX_STATUS). Raw output: $OUTPUT_LOG"
if [[ "$IS_GIT_REPO" -eq 1 ]]; then
  echo "codex-adapter: working-tree diff for review (nothing committed or pushed): $REVIEW_DIFF"
else
  echo "codex-adapter: '$DIR' is not a git repository -- no diff captured; review the files directly."
fi
echo "codex-adapter: this run is NOT committed or pushed automatically -- review it under the same gate as any other agent-produced change."

exit "$CODEX_STATUS"
