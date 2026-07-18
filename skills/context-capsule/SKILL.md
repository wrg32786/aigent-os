---
name: context-capsule
description: The capsule verb, invoked explicitly — reconcile from the live memory, write a resume-ready capsule, stamp nothing yourself, stop. Mid-session checkpoint or completion capsule; the threshold-triggered path runs the SAME contract automatically via the injected RefreshRequest.
trigger: /context-capsule
status: Two-verb lifecycle — supersedes the v1 capsule skill and absorbs /close (there is no separate close ceremony).
related:
  - "docs/two-verb-lifecycle.md (design doc — the gate, the supervisor cycle, sovereignty rules)"
  - "daemons/capsule-verb.mjs (trusted writer — REQUIRED_CAPSULE_FIELDS, refusal rules)"
  - "daemons/capsule-content-gate.mjs (content gate; shared with the stop-writer)"
  - "skills/resume/SKILL.md (the mirror verb)"
---

# /context-capsule — the capsule verb

**The entire job: reconcile → write the capsule → STOP.** The capsule absorbs `/close`: there is no separate close ceremony. Digests, pointer stamping, and `cycle_token` belong to the trusted writer (`daemons/capsule-verb.mjs` + `daemons/curated-close-pointer.mjs`) — the operator authors content and never stamps machinery fields.

## When this skill fires vs the automatic verb

The threshold-triggered refresh does NOT need this skill — if a fork wires a controller, it injects a RefreshRequest carrying cycle + challenge, and the autofire worker consumes your capsule when the transcript falls still. Invoke `/context-capsule` for the explicit cases: a mid-session checkpoint before risky work, a completion capsule when a thread ships, or a handoff.

## Operator sovereignty (never violate)

- The capsule is **best-effort autosave, never a gate**. An operator `/clear` passes through whether or not a capsule landed; never tell the operator to wait on capsule machinery.
- A session rotation satisfies the cycle — never re-arm or service a refresh cycle against a fresh session.
- If a RefreshRequest is active: author the capsule, then **go quiet** — the seal fires on transcript stillness. Every extra tool call resets the clock.

## Fences (never cross)

- **Do NOT read the refresh machinery** — sensor, worker, supervisor, CAS/marker code. Sealing is automatic and none of the operator's business; the urge to "understand how it's invoked" IS the bug.
- **Do NOT stamp digests, pointer, or cycle_token** — trusted-writer territory. A self-stamped digest is refused anyway.
- **Do NOT write a narration capsule.** Reconcile-from-memory is the value: a capsule that restates the transcript instead of the live memory/git state is the trap this verb exists to prevent.

## Steps (tight + terminal)

1. **RECONCILE from live memory** — re-read the session log, active priorities, and this session's git commits. Record what happened, not what was said. Budget: **2–4 reads, no more**.
2. **WRITE** `vault/memory/capsules/<YYYY-MM-DD>-<slug>.md`:
   - Frontmatter — all four REQUIRED fields non-empty, no inline `#` comments on them, `waiting_on` quoted (never bare `null`): `id`, `objective`, `waiting_on`, `next_valid_action`; plus `parent_capsule_id`, `status: active`, `trigger`, `expires`, `tags`, `created_at`, and `definition_hash` = first 12 hex of sha256(objective + next_valid_action).
   - Body — `[REFERENCE ONLY]` banner, then: `Done (don't redo)` · `Historical-Errors → Resolutions` · `Historical-Rejected-Approaches` · `Files-Read / Files-Modified` · `Operating-Facts` · `Pending-Gates` · `Claimed-Rows`. Historical- prefixes and latest-wins stay (anti-zombie).
   - `waiting_on` is the resume contract: write it so a fresh session can act from it alone — concrete items, owners, gates.
3. **STOP.** One line acknowledging the capsule path, then silence. No verification reads, no pointer checks — the writer refuses loudly if content fails its gate, and a refusal names the exact field to fix.

## Lifecycle

`active → resumed → resolved`. The resume verb flips `active → resumed` when it acts from the capsule; a capsule superseded by a newer one, or `resumed` >30 days, resolves. `/open`/`/close` are retired — resume absorbs open, this verb absorbs close.

## When NOT to capsule

- Mid-thought (finish the thought).
- Trivial sessions a fresh session could reconstruct from memory alone.
- Inside a dispatched sub-agent (the dispatch brief IS the capsule).

## Known issue (documented, not fixed here)

Fresh autosave capsules seed `waiting_on: null` (the stop-capsule-writer's `skeleton()` template). The content gate then refuses to treat them as a resumable receipt for the trusted-writer path, which can abort an automated refresh cycle mid-flight if a fork wires one. This is a real gap in the ported architecture, not a design choice — see docs/two-verb-lifecycle.md's "Known issue" section. The fix is planned as a follow-up commit on this same branch, not bundled into this port.
