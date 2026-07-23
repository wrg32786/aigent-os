---
name: context-capsule
description: The capsule verb, invoked explicitly — reconcile from the live memory, write a resume-ready capsule, then stop. Mid-session checkpoint or completion capsule; a rolling best-effort version of the same write also runs automatically on every Stop event via daemons/stop-capsule-writer.mjs.
trigger: /context-capsule
status: Two-verb lifecycle — supersedes the v1 capsule skill and absorbs /close (there is no separate close ceremony).
related:
  - "docs/two-verb-lifecycle.md (design doc — schema, content gate, sovereignty rules)"
  - "daemons/capsule-verb.mjs (validateCapsuleText — required fields + content gate)"
  - "daemons/capsule-content-gate.mjs (content gate; shared with the stop-writer)"
  - "skills/resume/SKILL.md (the mirror verb)"
---

# /context-capsule — the capsule verb

**The entire job: reconcile → write the capsule → sync the vault → STOP.** The capsule absorbs `/close`: there is no separate close ceremony, and no separate stamping step — writing a valid capsule (content gate passes, required fields non-empty) is the capsule contract.

## When this skill fires vs the automatic verb

A rolling, best-effort version of this write already runs on every `Stop` event via `daemons/stop-capsule-writer.mjs` — you don't need this skill for ordinary turn-by-turn capture. Invoke `/context-capsule` for the explicit cases: a mid-session checkpoint before risky work, a completion capsule when a thread ships, or a handoff.

## Operator sovereignty (never violate)

- The capsule is **best-effort autosave, never a gate**. An operator `/clear` passes through whether or not a capsule landed; never tell the operator to wait on capsule machinery.

## Fences (never cross)

- **Do NOT write a narration capsule.** Reconcile-from-memory is the value: a capsule that restates the transcript instead of the live memory/git state is the trap this verb exists to prevent.

## Steps (tight + terminal)

1. **RECONCILE from live memory** — re-read the session log, active priorities, and this session's git commits. Record what happened, not what was said. Budget: **2–4 reads, no more**.
2. **WRITE** `vault/memory/capsules/<YYYY-MM-DD>-<slug>.md`:
   - Frontmatter — all four REQUIRED fields non-empty, no inline `#` comments on them, `waiting_on` quoted (never bare `null`): `id`, `objective`, `waiting_on`, `next_valid_action`; plus `parent_capsule_id`, `status: active`, `trigger`, `expires`, `tags`, `created_at`. `resume_trigger` and `success_criteria` are OPTIONAL — include them when they add real signal, omit otherwise.
   - Body — `[REFERENCE ONLY]` banner, then: `Done (don't redo)` · `Historical-Errors → Resolutions` · `Historical-Rejected-Approaches` · `Files-Read / Files-Modified` · `Operating-Facts` · `Pending-Gates` · `Claimed-Rows`. Historical- prefixes and latest-wins stay (anti-zombie).
   - `waiting_on` is the resume contract: write it so a fresh session can act from it alone — concrete items, owners, gates.
3. **SYNC fail-soft.** After the capsule and any memory edits land, run `node daemons/vault-sync.mjs`. It resolves the installed root from `.aigent/state.json`, stages only capsule/memory changes, and handles no-remote or push-failure outcomes without prompting or gating the lifecycle.
4. **STOP.** One line acknowledging the capsule path, then silence. Self-check the frontmatter against the field list and the content gate (injection echo / ceremony action, `daemons/capsule-content-gate.mjs`) before writing — there is no separate trusted-writer pass to catch a mistake after the fact.

## Lifecycle

`active → resumed → resolved`. The resume verb flips `active → resumed` when it acts from the capsule; a capsule superseded by a newer one, or `resumed` >30 days, resolves. `/open`/`/close` are retired — resume absorbs open, this verb absorbs close.

## When NOT to capsule

- Mid-thought (finish the thought).
- Trivial sessions a fresh session could reconstruct from memory alone.
- Inside a dispatched sub-agent (the dispatch brief IS the capsule).
