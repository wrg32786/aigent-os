#!/usr/bin/env bash
# Fast installer regression suite: every install.sh behavioral scenario
# EXCEPT the full REAL_TARGET + doctor.sh smoke test, which lives in
# tests/test-installer-slow-smoke.sh (a much bigger install against the
# actual 100+ file repo tree -- minutes, not seconds, in a slow sandbox).
# Split so a debugging loop or CI gate never has to eat the slow smoke
# test's wall-clock cost to get signal on everything else.
#
# Every scenario below prints a numbered progress line on completion, so a
# long run is never a silent black box -- if this hangs or gets killed, the
# last printed line tells you exactly how far it got.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

TOTAL=13

json_valid() {
  local file="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -m json.tool "$file" >/dev/null
  elif command -v python >/dev/null 2>&1; then
    python -m json.tool "$file" >/dev/null
  else
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$file"
  fi
}

make_fixture() {
  local source="$1"
  mkdir -p "$source"/{system,vault/agents,skills/demo,hooks,daemons/semantic-search,scripts,docs,memory,evals,.claude/rules}
  cp "$ROOT/install.sh" "$source/install.sh"
  printf '# Identity\n' > "$source/system/00_identity.md"
  printf '# Claude source\n' > "$source/CLAUDE.md"
  printf '%s\n' '---' 'name: demo' '---' > "$source/skills/demo/SKILL.md"
  printf '%s\n' '---' 'name: scout' 'tools: [Read]' '---' > "$source/vault/agents/scout.md"
  printf '# critical\n' > "$source/.claude/rules/post-compact-critical.md"
  cat > "$source/.claude/settings.json.template" <<'JSON'
{"env":{"AIGENT_ROOT":"__AIGENT_ROOT__","AIGENT_VAULT":"__AIGENT_ROOT__"},"hooks":{"SessionEnd":[]}}
JSON
  printf '[]\n' > "$source/.claude/skill-index.json"
  printf '{"name":"semantic-search","version":"1.0.0"}\n' > "$source/daemons/semantic-search/package.json"
  printf '#!/bin/sh\necho "trusted"\n' > "$source/hooks/example-hook.sh"
}

# make_symlink: plain `ln -s` on Windows silently falls back to COPYING the
# target instead of erroring when the process lacks symlink privilege
# (Developer Mode / SeCreateSymbolicLinkPrivilege) -- which GitHub's
# windows-latest runners do not have by default. That would make the
# symlink-guard assertions below pass or fail for the wrong reason without
# ever exercising the guard they're meant to test. MSYS=winsymlinks makes
# Git Bash create an MSYS-emulated symlink instead (still real per
# -L/readlink, still the exact form Git Bash on Windows produces in the
# wild) when the native path fails.
make_symlink() {
  local dest="$1" link="$2"
  # `|| true` on both attempts: under set -e a bare failing statement here
  # would abort this whole test script before ever reaching the fallback
  # (or the final diagnostic) below -- exactly the bug this suite's own
  # symlink-guard tests exist to catch elsewhere, reintroduced by accident.
  ln -s "$dest" "$link" 2>/dev/null || true
  if [[ ! -L "$link" ]]; then
    rm -f "$link"
    MSYS=winsymlinks ln -s "$dest" "$link" || true
  fi
  [[ -L "$link" ]] || { printf 'FAIL: could not create a real symlink at %s (even with MSYS=winsymlinks)\n' "$link" >&2; exit 1; }
}

FIXTURE="$WORK/source"
make_fixture "$FIXTURE"

# ── 1. In-place activation ───────────────────────────────────────────────────
(
  cd "$FIXTURE"
  bash install.sh --no-deps >/dev/null
)
test -f "$FIXTURE/.claude/settings.json"
test -f "$FIXTURE/.aigent/state.json"
test ! -d "$FIXTURE/--no-deps"
json_valid "$FIXTURE/.claude/settings.json"
printf '[1/%d] in-place activation: ok\n' "$TOTAL"

# ── 2. Copy install, flags before target, spaced path ───────────────────────
TARGET="$WORK/target with spaces"
(
  cd "$FIXTURE"
  bash install.sh --no-deps --target "$TARGET" >/dev/null
)
# install.sh writes the canonicalized (pwd -P) form of TARGET into settings.json,
# not the raw mktemp string -- on Windows Git Bash /tmp aliases the user temp dir,
# and on macOS /tmp symlinks /private/tmp, so the two forms differ there. Compare
# against the same canonical form the installer itself writes.
TARGET_CANON="$(cd "$TARGET" && pwd -P)"
test -f "$TARGET/system/00_identity.md"
test -d "$TARGET/memory"
test -d "$TARGET/evals"
json_valid "$TARGET/.claude/settings.json"
grep -F "$TARGET_CANON" "$TARGET/.claude/settings.json" >/dev/null
printf '[2/%d] copy install with spaced path: ok\n' "$TOTAL"

# ── 3. Rerun refreshes one managed block ─────────────────────────────────────
(
  cd "$FIXTURE"
  bash install.sh "$TARGET" --no-deps >/dev/null
)
test "$(grep -c '<!-- aigent-os:start -->' "$TARGET/CLAUDE.md")" -eq 1
test "$(grep -c '# aigent-os:generated-state:start' "$TARGET/.gitignore")" -eq 1
printf '[3/%d] rerun refreshes single managed block: ok\n' "$TOTAL"

# ── 4. Existing valid settings merged ────────────────────────────────────────
MERGE_TARGET="$WORK/merge-target"
mkdir -p "$MERGE_TARGET/.claude"
cat > "$MERGE_TARGET/.claude/settings.json" <<'JSON'
{"env":{"CUSTOM":"keep","AIGENT_ROOT":"/stale/path"},"permissions":{"allow":["Read"]}}
JSON
(
  cd "$FIXTURE"
  bash install.sh --target "$MERGE_TARGET" --no-deps >/dev/null
)
MERGE_TARGET_CANON="$(cd "$MERGE_TARGET" && pwd -P)"
json_valid "$MERGE_TARGET/.claude/settings.json"
grep -F '"CUSTOM": "keep"' "$MERGE_TARGET/.claude/settings.json" >/dev/null
grep -F "$MERGE_TARGET_CANON" "$MERGE_TARGET/.claude/settings.json" >/dev/null
printf '[4/%d] existing valid settings.json merged: ok\n' "$TOTAL"

# ── 5. Invalid settings left untouched ───────────────────────────────────────
INVALID_TARGET="$WORK/invalid-target"
mkdir -p "$INVALID_TARGET/.claude"
printf '{invalid\n' > "$INVALID_TARGET/.claude/settings.json"
(
  cd "$FIXTURE"
  bash install.sh --target "$INVALID_TARGET" --no-deps >/dev/null
)
grep -F '{invalid' "$INVALID_TARGET/.claude/settings.json" >/dev/null
json_valid "$INVALID_TARGET/.claude/settings.aigent.json"
printf '[5/%d] invalid settings.json left untouched: ok\n' "$TOTAL"

# ── 6. Dry run creates nothing ───────────────────────────────────────────────
DRY_TARGET="$WORK/dry-target"
(
  cd "$FIXTURE"
  bash install.sh --target "$DRY_TARGET" --dry-run --no-deps >/dev/null
)
test ! -e "$DRY_TARGET"
printf '[6/%d] dry run creates nothing: ok\n' "$TOTAL"

# ── 7. Symlink-escape guard, critical file (Codex finding #22) ──────────────
# A single-critical-file write (CLAUDE.md) refuses through a pre-seeded
# symlink and aborts the whole install with an actionable error, rather than
# following the link and overwriting whatever it points at.
SYMLINK_TARGET="$WORK/symlink-target"
mkdir -p "$SYMLINK_TARGET"
SENTINEL="$WORK/sentinel.txt"
printf 'do not touch\n' > "$SENTINEL"
make_symlink "$SENTINEL" "$SYMLINK_TARGET/CLAUDE.md"
set +e
SYMLINK_OUT="$(cd "$FIXTURE" && bash install.sh --target "$SYMLINK_TARGET" --no-deps 2>&1)"
SYMLINK_RC=$?
set -e
test "$SYMLINK_RC" -ne 0
printf '%s\n' "$SYMLINK_OUT" | grep -qi "refusing to write through symlink"
test "$(cat "$SENTINEL")" = "do not touch"
printf '[7/%d] symlink escape (critical file): refused, sentinel untouched\n' "$TOTAL"

# ── 8. Symlink-escape guard, many-file site ──────────────────────────────────
# A many-file copy site (the .claude/skills/<name> install loop) skips just
# the affected entry with a warning and lets the rest of the install finish,
# rather than aborting entirely.
SKIP_TARGET="$WORK/skip-target"
mkdir -p "$SKIP_TARGET/.claude/skills"
make_symlink "$WORK/nonexistent-escape-target" "$SKIP_TARGET/.claude/skills/demo"
SKIP_OUT="$(cd "$FIXTURE" && bash install.sh --target "$SKIP_TARGET" --no-deps 2>&1)"
test -f "$SKIP_TARGET/.claude/settings.json"
printf '%s\n' "$SKIP_OUT" | grep -qi "\[skip\] refusing to write through symlink"
test ! -e "$WORK/nonexistent-escape-target"
printf '[8/%d] symlink escape (many-file site): skipped with warning, install completed\n' "$TOTAL"

# ── 9. Hooks quarantine (Codex finding #19) ──────────────────────────────────
# A pre-existing file at a path the installer would place a framework hook
# is quarantined (moved aside, framework version installed) by default.
QUARANTINE_TARGET="$WORK/quarantine-target"
mkdir -p "$QUARANTINE_TARGET/hooks"
printf '#!/bin/sh\necho "MALICIOUS"\n' > "$QUARANTINE_TARGET/hooks/example-hook.sh"
QUARANTINE_OUT="$(cd "$FIXTURE" && bash install.sh --target "$QUARANTINE_TARGET" --no-deps 2>&1)"
printf '%s\n' "$QUARANTINE_OUT" | grep -qi "\[quarantine\]"
grep -q "trusted" "$QUARANTINE_TARGET/hooks/example-hook.sh"
grep -rq "MALICIOUS" "$QUARANTINE_TARGET/.aigent/quarantine/"
printf '[9/%d] hooks quarantine: planted file moved aside, trusted version installed\n' "$TOTAL"

# ── 10. Skills quarantine ─────────────────────────────────────────────────────
# Same bug class, one directory over: .claude/skills/<name>/SKILL.md is a
# dispatchable slash command Claude Code reads directly, so a planted,
# differing SKILL.md must quarantine exactly like a hook.
SKILLS_QUAR_TARGET="$WORK/skills-quarantine-target"
mkdir -p "$SKILLS_QUAR_TARGET/.claude/skills/demo"
printf '%s\n' '---' 'name: demo' 'MALICIOUS' '---' > "$SKILLS_QUAR_TARGET/.claude/skills/demo/SKILL.md"
SKILLS_QUAR_OUT="$(cd "$FIXTURE" && bash install.sh --target "$SKILLS_QUAR_TARGET" --no-deps 2>&1)"
printf '%s\n' "$SKILLS_QUAR_OUT" | grep -qi "\[quarantine\]"
! grep -q "MALICIOUS" "$SKILLS_QUAR_TARGET/.claude/skills/demo/SKILL.md"
grep -rq "MALICIOUS" "$SKILLS_QUAR_TARGET/.aigent/quarantine/"
printf '[10/%d] skills quarantine: planted SKILL.md moved aside, trusted version installed\n' "$TOTAL"

# ── 11. Agents quarantine ─────────────────────────────────────────────────────
# .claude/agents/<name>.md is a dispatchable subagent definition -- same
# treatment.
AGENTS_QUAR_TARGET="$WORK/agents-quarantine-target"
mkdir -p "$AGENTS_QUAR_TARGET/.claude/agents"
printf '%s\n' '---' 'name: scout' 'tools: [Read]' 'MALICIOUS' '---' > "$AGENTS_QUAR_TARGET/.claude/agents/scout.md"
AGENTS_QUAR_OUT="$(cd "$FIXTURE" && bash install.sh --target "$AGENTS_QUAR_TARGET" --no-deps 2>&1)"
printf '%s\n' "$AGENTS_QUAR_OUT" | grep -qi "\[quarantine\]"
! grep -q "MALICIOUS" "$AGENTS_QUAR_TARGET/.claude/agents/scout.md"
grep -rq "MALICIOUS" "$AGENTS_QUAR_TARGET/.aigent/quarantine/"
printf '[11/%d] agents quarantine: planted scout.md moved aside, trusted version installed\n' "$TOTAL"

# ── 12. --trust-existing opt-out ─────────────────────────────────────────────
# Keeps pre-existing hooks/skills/agents instead of quarantining them,
# across all three sensitive trees at once.
TRUST_TARGET="$WORK/trust-target"
mkdir -p "$TRUST_TARGET/hooks" "$TRUST_TARGET/.claude/skills/demo" "$TRUST_TARGET/.claude/agents"
printf '#!/bin/sh\necho "CUSTOM"\n' > "$TRUST_TARGET/hooks/example-hook.sh"
printf '%s\n' '---' 'name: demo' 'CUSTOM' '---' > "$TRUST_TARGET/.claude/skills/demo/SKILL.md"
printf '%s\n' '---' 'name: scout' 'tools: [Read]' 'CUSTOM' '---' > "$TRUST_TARGET/.claude/agents/scout.md"
TRUST_OUT="$(cd "$FIXTURE" && bash install.sh --target "$TRUST_TARGET" --trust-existing --no-deps 2>&1)"
grep -q "CUSTOM" "$TRUST_TARGET/hooks/example-hook.sh"
grep -q "CUSTOM" "$TRUST_TARGET/.claude/skills/demo/SKILL.md"
grep -q "CUSTOM" "$TRUST_TARGET/.claude/agents/scout.md"
! printf '%s\n' "$TRUST_OUT" | grep -qi "\[quarantine\]"
printf '[12/%d] trust-existing opt-out (hooks+skills+agents): pre-existing kept, no quarantine\n' "$TOTAL"

# ── 13. Backup-leaf symlink guard (Codex finding #22 item 2) ─────────────────
# STAMP is normally date -u at runtime, so a test can't predict the backup
# filename to pre-plant a symlink at. AIGENT_INSTALL_STAMP (test-only, see
# install.sh) pins it so the exact path is known before the second run.
BACKUP_STAMP="20260101T000000Z"
BACKUP_TARGET="$WORK/backup-symlink-target"
(
  cd "$FIXTURE"
  AIGENT_INSTALL_STAMP="$BACKUP_STAMP" bash install.sh --target "$BACKUP_TARGET" --no-deps >/dev/null
)
BACKUP_SENTINEL="$WORK/backup-sentinel.txt"
printf 'do not touch\n' > "$BACKUP_SENTINEL"
make_symlink "$BACKUP_SENTINEL" "$BACKUP_TARGET/.aigent/backups/CLAUDE.md.$BACKUP_STAMP"
set +e
BACKUP_OUT="$(cd "$FIXTURE" && AIGENT_INSTALL_STAMP="$BACKUP_STAMP" bash install.sh --target "$BACKUP_TARGET" --no-deps 2>&1)"
BACKUP_RC=$?
set -e
test "$BACKUP_RC" -ne 0
printf '%s\n' "$BACKUP_OUT" | grep -qi "refusing to write through symlink"
test "$(cat "$BACKUP_SENTINEL")" = "do not touch"
printf '[13/%d] backup-leaf symlink guard: refused, sentinel untouched\n' "$TOTAL"

printf 'fast installer suite passed (%d/%d)\n' "$TOTAL" "$TOTAL"
