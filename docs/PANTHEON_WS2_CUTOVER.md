# WS2 — Lifecycle canary cutover checklist (metis seat first)
*2026-07-24 — metis. DoD artifact for PAN-706: "cutover checklist with named kill-switch
(old flow) written." Fleet-wide flip is the PROGRAM'S LAST ACT (Mike ruling) — this
checklist covers the ONE-canary soak only.*

## Measured current state (own-hand, 2026-07-24 02:2xZ)

Each seat's lifecycle rides FIVE hook wirings in its `.claude/settings.local.json`,
all pointing at the OLD fleet-port copies in
`~/pantheon/pantheon/packages/orchestration/`:
Stop → `stop-capsule-writer.mjs` · PreCompact → `precompact-flush.mjs` ·
UserPromptSubmit → `userpromptsubmit-journal.mjs` · SessionEnd → `sessionend-flush.mjs` ·
SessionStart → `sessionstart-reinject.mjs`.

**Multi-seat scoping today is IMPLICIT and already per-seat:** no launcher exports
`AIGENT_ROOT`/`AIGENT_SEAT_ID` (grep over `~/pantheon/bin/launch-*.sh`: zero hits) —
the daemons resolve root from the hook payload's cwd, which is the seat's own vault.
The §3.2 FROZEN requirement (per-seat `AIGENT_ROOT`) is therefore satisfied at the
hook seam by making the root EXPLICIT per hook command at cutover, not by touching
launchers: the fork's daemons read `AIGENT_ROOT || CLAUDE_PROJECT_DIR || payload.cwd`
(stop-capsule-writer.mjs:70), so an env prefix on the hook command pins it hard.
The vault-global capsule store never collides because no two seats share a vault —
the collision class recon C warned about requires a SHARED root, which our wiring
never creates. Assert this at soak: capsules land only in the canary's own vault.

## The flip (canary = metis seat — she felt the wedge, she eats the risk first)

1. **Pre-flip bank:** natural Stop banks the capsule (no manual step — the old flow
   keeps working until the settings edit lands).
2. **Backup:** copy `.claude/settings.local.json` → `.bak-ws2cutover` (the standing
   .bak convention; this file IS the kill-switch's restore point).
3. **Repoint the five hook commands** to the fork tree's `daemons/*.mjs` at a pinned
   deploy checkout (never the build tree), each with explicit
   `AIGENT_ROOT=<seat vault>` env prefix.
4. **Old-flow disarm on the canary only:** the old port's writers stop firing because
   the hooks no longer invoke them (one wiring, one owner — no double-writer window).
   The port-added pointer file `memory/runtime/last-capsule.json` goes STALE BY
   DESIGN from this moment and nothing may read it (resume = `newestValidCapsule()`
   scan; the 3/3-seat stale-pointer class dies here, rung 4).
5. **Soak (DoD):** N full bank/clear/resume cycles, zero supervisor involvement;
   fault-injection fixture (kill mid-bank) recovers; capsules verified landing only
   in the canary vault; `[OPERATOR]`-sweep spot-check confirms the two branch fixes
   hold on live traffic (no injected objective, no relay-as-OPERATOR).

## Kill-switch (named, two levels)

- **Soft (runtime):** `LIFECYCLE_KILL_STOP_WRITER=1` on the Stop hook command —
  upstream's own kill-switch, disables the writer without touching wiring.
- **Hard (full revert):** restore `.claude/settings.local.json.bak-ws2cutover` —
  the OLD FLOW IS THE KILL-SWITCH TARGET: old port daemons remain on disk untouched
  through the entire soak (their DELETE waits for fleet cutover, the program's last
  act), so restoring the settings file alone re-arms the pre-cutover lifecycle in
  one step. No process restart needed beyond the next session boot.

## Explicitly NOT in this flip

Fleet-wide repoint (LAST ACT) · deleting the old port machinery · auto-clear
supervisor changes · CONTINUATION_INFLIGHT retirement on other seats · any daemon
beyond the five hook wirings (the fork's other ~14 daemons are out of adoption
scope for WS2).
