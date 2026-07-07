---
title: Somatic v0.4.1 Wiring
tags: [doctrine, architecture, somatic, banked, queued]
aliases: ["v0.4.1", "somatic wiring", "v0.4.1 wiring release"]
created: 2026-05-02
status: banked
---

# Somatic v0.4.1 — Wiring Release

> [!warning] BANKED, NOT DISPATCHED. Gate: 1-2 real-use sessions of v0.4 must pass before this ships. Plan-on-paper looks clean; plan-in-the-wild always reveals an assumption that didn't hold.

The wiring release that makes v0.4 organs actually circulate inside the existing the AIgent rhythm. No new concepts — just integration of [[Somatic Layer]] into `/open`, `/close`, and Caddy.

Designed in the 2026-05-02 Codex+the AIgent collaboration session. Final scope locked after Codex agreed with the AIgent's 4 sharpenings (small last_capsule, lifecycle resolved-trigger, mute auto-expiry, parent_capsule_id chain field).

## Brief (one-line for Lyra dispatch)

> Wire somatic continuity into the AIgent without daemon creep. `/body-check` is the only body-state compute path and caches bounded BODY_STATE.json. `/open` offers resume from last_capsule with one extra capsule read. `/close` digests staged memory, creates capsules at task-completion boundaries, and updates last_capsule. Capsules carry lifecycle status and optional parent_capsule_id. Caddy adds class-tagged hints with strict digest thresholds and 4-hour default class mutes.

## Scope (6 changes)

### 1. BODY_STATE.json gets `last_capsule` field

Bounded shape only:

```json
{
  "last_capsule": {
    "id": "2026-05-02-aigent-somatic-v04",
    "path": "memory/capsules/2026-05-02-aigent-somatic-v04.md",
    "objective": "Design the AIgent v0.4 somatic layer",
    "status": "active",
    "created_at": "2026-05-02T18:00:00Z"
  }
}
```

**No `resume_prompt` embedded.** Lives in capsule file. /open does ONE extra file read to fetch it. Keeps BODY_STATE.json bounded per Letta block discipline.

### 2. Capsule lifecycle states

`active → resumed → resolved`

Transitions:
- **active → resumed**: /open offers resume, principal accepts.
- **resumed → resolved**:
  - /digest or /close detects all capsule open_threads closed, OR
  - explicit `/capsule-resolve <id>`, OR
  - auto-resolve: any `resumed` capsule older than 30 days.

Keep simple in v0.4.1. If thread-matching is fuzzy, don't overbuild — explicit resolve + 30-day expiry is enough. /open only offers `active` capsules.

### 3. Capsule chains via frontmatter

Add to capsule frontmatter:

```yaml
---
capsule_id: 2026-05-02-aigent-somatic-v04
objective: Design the AIgent v0.4 somatic layer
parent_capsule_id: <id of capsule this resumed from>  # optional
created: 2026-05-02
status: active
---
```

No traversal logic in v0.4.1 — just capture lineage. Chain walking is v0.5+ if narrative reconstruction becomes valuable.

### 4. /open resume offering

Flow:
```
/open reads BODY_STATE.json
If last_capsule exists AND status == active:
  read capsule file
  surface ONE line: "Last session ended with a capsule: {objective}. Resume?"
  If yes: paste/use resume_prompt from capsule
  If no: continue normal /open
```

**Important: do not dump the capsule.** Just offer the resume handle.

### 5. /close updates

- If MEMORY_CANDIDATES.md has staged entries → run /digest review
- If context_pressure ≥ medium OR open_threads > threshold → create context-capsule (auto, because /close IS a completion trigger per Acontext doctrine)
- Refresh BODY_STATE.json after memory updates (set `last_capsule` if a new capsule was created)
- If new capsule was created and previous capsule was `active`, mark previous as `resumed` (the new one supersedes for /open purposes)

`/close` may create capsules autonomously — they're state-preserving. But never auto-promote candidates from /digest.

### 6. Caddy class-based mute + class-tagged hints

**Class tags on hints:**
- `[CADDY:memory]` — /digest, /promote, candidate triggers
- `[CADDY:context]` — /context-capsule, compact triggers
- `[CADDY:body]` — /body-check, vital sign triggers
- `[CADDY:routing]` — model routing, sandbox routing
- `[CADDY:all]` — global mute

**Mute file:** `memory/CADDY_MUTES.json`

```json
{
  "memory": {
    "muted_until": "2026-05-02T18:00:00Z",
    "reason": "digest hint fatigue during design session",
    "default_duration_hours": 4
  }
}
```

**Rules:**
- If no `default_duration_hours` supplied, default to 4
- If `muted_until` missing/null, compute `now + 4h`
- No permanent mute unless explicitly requested with `--forever`

**`/caddy-mute` skill update:**
```
/caddy-mute --class memory          # 4h default
/caddy-mute --class memory --hours 1 # 1h
/caddy-mute --class memory --forever # explicit permanent (rare)
/caddy-mute --class all             # nuclear
```

## Digest hint discipline

**Normal rule:** trigger phrase + concrete payload + max 1 memory hint per session.

**Bypass max-1 limit for explicit memory-authoring phrases:**
- "remember that X"
- "new rule: X"
- "from now on, X"
- "rule: X"

Still must have concrete payload — `X` must be a captured fact, not a forward-looking instruction without a noun.

## Implementation notes

- `/body-check` IS the body-state refresh. No separate `daemons/somatic/refresh-body-state.js`. Codex's original v0.4.1 had a separate refresh script — the AIgent pushed back, Codex agreed: lazy compute via `/body-check` only. Computing in two places is the duplicate-state anti-pattern.
- `doctor.sh` / `/system-check` should add existence checks for somatic files (already in v0.4 — not v0.4.1 work).
- Light docs: CHANGELOG entry, link `system/15_somatic_layer.md` from CLAUDE.md or README. Don't over-document yet.

## What v0.4.1 explicitly does NOT add

- No agent fitness (deferred to v0.5)
- No dream log
- No polling daemon
- No autonomous promotion
- No automatic doctrine edits
- No external repo research loop
- No adaptive authority matrix yet

## Acceptance criteria

v0.4.1 is done when:

1. `/open` notices high body pressure without dumping a dashboard
2. `/open` offers capsule resume one-line if last_capsule.status == active
3. `/close` offers /digest if candidates are staged
4. `/close` creates a context-capsule when appropriate
5. `/close` updates last_capsule and may demote previous to `resumed`
6. Caddy surfaces 3 new class-tagged hints (memory/context/body)
7. `/caddy-mute --class <name>` works with 4h auto-expiry default
8. Digest hint phrase+payload rule enforced; bypass list works
9. `/system-check` knows whether somatic layer is installed
10. Existing /open and /close outputs still feel tight — no dashboard bloat

## Cross-links

- [[Somatic Layer]] — v0.4 doctrine + cross-pattern attribution
- [[system/15_somatic_layer.md]] — canonical doctrine doc
- [[Hestia]] — /digest invokes during her 7-day sweep cadence
- [[Pipeline Verification Doctrine]] — same trust-but-verify discipline
- [[Memory Decay Doctrine]] — HEAT_INDEX informs body-state attention pressure
- [[2026-05-02]] — session daily where this was designed

## Sequencing

| Trigger | Action |
|---|---|
| Now (2026-05-02) | Spec banked. /close + /open continue current behavior. |
| After 1-2 real sessions of v0.4 use | Verify /body-check has signals to read; verify /digest catches real candidates from real session phrases; verify /context-capsule produces a capsule that's actually resumable. |
| If green | Dispatch Lyra for v0.4.1 build. |
| If rough edges | Adjust this spec, re-bank, re-test. |
