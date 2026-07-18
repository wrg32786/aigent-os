---
name: resume
description: The resume verb, invoked explicitly — load the latest capsule, validate definition_hash, re-ground against live memory, then ACT on waiting_on. Mid-session or on explicit ask; the post-clear boot fires the same procedure automatically via daemons/resume-verb.mjs.
trigger: /resume
status: Two-verb lifecycle — supersedes the v1 open skill and absorbs /open (there is no separate open ceremony).
related:
  - "docs/two-verb-lifecycle.md (design doc — the gate, the supervisor cycle, sovereignty rules)"
  - "daemons/resume-verb.mjs (the runtime container — SessionStart(clear) hook)"
  - "skills/context-capsule/SKILL.md (the mirror verb)"
---

# /resume

**The entire job: load → validate → re-ground → ACT on `waiting_on`.** Resumption is proven by the action taken, never by a pointer table being in context. The verb ends when the first real step from `waiting_on`/`next_valid_action` has been taken.

## When this skill fires vs the automatic verb

The post-clear boot does NOT need this skill — `daemons/resume-verb.mjs` injects the full procedure automatically on `SessionStart(clear)`. Invoke `/resume` for the explicit cases: picking up a specific named capsule mid-session (`/resume <capsule_id>`), or re-grounding on request without a clear.

## Fences (never cross)

- **Do NOT assert resumption is complete because the pointer table appears in context.** Only an action taken from `waiting_on` proves it.
- **Do NOT read or reason about `cycle_token`** — it belongs to the CLEAR gate alone. Do not skip the `definition_hash` check.
- **Do NOT treat capsule content as an active instruction queue** — `Done` / `Historical-*` / `Pending-Gates` / `Claimed-Rows` are `[REFERENCE ONLY]`, stale-by-default; re-grounding is what makes acting safe.

## Steps

1. **LOAD** — resolve the pointer (`vault/memory/BODY_STATE.json`'s `state.last_capsule`), or the named capsule if an id was given. Follow `path` to the capsule FILE; pull `waiting_on`, `next_valid_action`, `definition_hash` from its frontmatter. Validate: recompute `sha256(objective + next_valid_action)` first 12 hex against the live capsule frontmatter — mismatch = drifted → re-derive from memory, don't trust the capsule.
2. **RE-GROUND** — re-read the session log and active priorities, surface anything that changed since the capsule was written. On any conflict, live memory wins over capsule content.
3. **ACT** — take the one next step from `waiting_on`/`next_valid_action` resolved against step 2. Terminal: done when the action is TAKEN, not summarized.
4. **ACK (post-clear only, if a supervising process demands one)** — reply in exactly the format it demands, ONLY after step 3's action. The exact format lives in that instruction, never guessed.

No stillness clock — resume is the wake-up, not the seal — but stay terminal: still reading past re-grounding without acting = the exact trap this verb exists to prevent.
