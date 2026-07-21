---
title: Session Engine
tags: [daemon, session, architecture, refactor]
aliases: ["session engine", "open protocol", "close protocol"]
created: 2026-05-11
---

# Session Engine

> [!warning] SUPERSEDED — historical design artifact
> This spec decomposes the **retired** `/open` and `/close` commands. The shipped lifecycle is the two-verb model — `/resume` + `/context-capsule`, auto-firing on `SessionStart`/`Stop`; see [[../docs/two-verb-lifecycle.md|Two-Verb Lifecycle]] — current contract, beta (v0.9.0), see its known-issues note. The decomposition below is kept as design history and does NOT describe current shipped behavior. The command files it references (`.claude/commands/open.md`, `.claude/commands/close.md`) do not exist in the current tree.

> Phase 3 of the [[concepts/aigent-OS Refactor Spec|aigent-OS Refactor]]. Broke `/open` and `/close` from monolithic prompt blobs into discrete, named steps.

## Relationship to Current Commands

- `/open` and `/close` are retired. The skill files `skills/open/` and `skills/close/` remain on disk but are deprecated; there are no `.claude/commands/*.md` files in the current tree.
- This spec is the **logical step decomposition** of that retired flow, kept as design history. The shipped lifecycle replaced it with the two-verb model — see [[../docs/two-verb-lifecycle.md|Two-Verb Lifecycle]].

---

## /open — Step Decomposition

### Step 1: `loadVaultContext()`
**What:** Heat index traversal + daily note + session log
**Agent:** haiku (read-only, returns summary)
**Inputs:** `memory/HEAT_INDEX.json`, `daily/` latest, `memory/SESSION_LOG.md`
**Outputs:** Previous session context, open threads, next actions
**Current impl:** `/open` Step 1 — haiku agent graph traversal

### Step 2: `checkComms()`
**What:** CC unread summary — surface messages needing action
**Agent:** haiku (API call, filter, return)
**Inputs:** CC API `/api/messages/unread-summary?for=aigent`, sort=desc
**Outputs:** Sender + first 100 chars per unread; "none" if clear
**Current impl:** `/open` Step 1 sub-task (comms check, step 7)

### Step 3: `checkDecisionAging()`
**What:** 30/60/90 day decision reviews
**Agent:** haiku (reads two files, computes date deltas)
**Inputs:** `memory/DECISION_LOG.md`, `memory/DECISION_OUTCOMES.md`
**Outputs:** DUE entries: `{date} ({age}d): {summary}` — max 3, oldest first
**Current impl:** `/open` Step 1 sub-task (step 8)

### Step 4: `checkAttentionDrift()`
**What:** Priority vs. actual focus reconciliation
**Agent:** haiku (reads ACTIVE_PRIORITIES + last 7 daily notes, computes %)
**Inputs:** `memory/ACTIVE_PRIORITIES.md`, last 7 `daily/` notes
**Outputs:** Drift entries: `{project}: actual N% / intended M% — drift`; "none" if clean
**Current impl:** `/open` Step 1 sub-task (step 9)

### Step 5: `offerCapsuleResume()`
**What:** Check for active somatic capsule, offer resume
**Agent:** the AIgent inline (one-line surface, principal decides)
**Inputs:** `memory/BODY_STATE.json` → `state.last_capsule`
**Outputs:** Resume prompt if capsule active; silent skip otherwise
**Current impl:** `/open` Step 2.5

### Step 6: `runDigest()`
**What:** Process staged memory candidates — surface each with promote/skip/supersede options
**Agent:** the AIgent inline (interactive — never auto-promotes)
**Inputs:** `memory/MEMORY_CANDIDATES.md` filtered to `status: staged`
**Outputs:** Per-candidate actions applied; `status` + `digested_on` updated
**Trigger condition:** Only if staged candidates exist
**Current impl:** NEW — added to /open per the operator's request (S41d). Mirrors /close Step 0.5 behavior on session start so backlog doesn't accumulate between sessions.
**Dependency:** Runs AFTER `offerCapsuleResume()` so capsule context is available during promotion decisions.

### Step 7: `syncUsage()`
**What:** Silent usage daemon sync
**Agent:** the AIgent inline (bash, fire-and-forget)
**Inputs:** None
**Outputs:** Side effect only — `daemons/sync-usage.sh`
**Current impl:** `/open` Step 4 (silent)

---

## /close — Step Decomposition

### Step 0: `runDisciplineAudit()` (HARD GATE)
**What:** Honesty ledger, trust decay, failure modes, decision aging follow-up
**Agent:** the AIgent inline (scan session, write to ledger files)
**Gates:** A (honesty ledger), B (trust decay), C (failure modes), D (decision aging), E (Friday drift report)
**Blocks:** YES — gates must clear before Step 1
**Current impl:** `/close` Step 0

### Step 1: `runDigest()`
**What:** Process any staged memory candidates BEFORE vault commit
**Agent:** the AIgent inline (interactive — never auto-promotes)
**Inputs:** `memory/MEMORY_CANDIDATES.md` filtered to `status: staged`
**Outputs:** Per-candidate actions applied; promoted notes ready for Step 2
**Trigger condition:** Only if staged candidates exist; skip silently if none
**Ordering invariant:** MUST run before `commitMemory()` so any promoted candidates are included in the vault update pass
**Current impl:** `/close` Step 0.5-A (Somatic v0.4.1)

### Step 2: `commitMemory()`
**What:** Identify changed vault notes, read → edit each, create new notes as needed
**Agent:** the AIgent inline
**Inputs:** Session context, digest outputs from Step 1
**Outputs:** 2–6 vault notes updated; new notes created if needed
**Current impl:** `/close` Steps 1–2

### Step 3: `writeCapsule()`
**What:** Create resumable context capsule when pressure/work threshold met
**Agent:** the AIgent inline
**Inputs:** `memory/BODY_STATE.json`, session work summary
**Outputs:** `memory/capsules/<id>.md` written; BODY_STATE.json updated
**Trigger condition:** context_pressure >= medium OR delegation_open_count > 5 OR non-trivial work shipped
**Current impl:** `/close` Step 0.5-B and 0.5-C

### Step 4: `writeSessionLog()`
**What:** Daily note + SESSION_LOG entry
**Agent:** the AIgent inline
**Inputs:** Session summary, decisions, open threads
**Outputs:** `daily/YYYY-MM-DD.md` written; `memory/SESSION_LOG.md` top entry added
**Current impl:** `/close` Steps 3–4

### Step 5: `syncUsage()`
**What:** Silent usage daemon sync (final)
**Agent:** the AIgent inline (bash)
**Outputs:** Side effect only — `daemons/sync-usage.sh`
**Current impl:** `/close` Step 6

### Step 6: `runSystemCheck()`
**What:** Somatic stack smoke test
**Agent:** the AIgent inline (bash, capture exit code)
**Inputs:** None
**Outputs:** PASS/FAIL lines in commit summary; surfaces FAILs to the operator
**Current impl:** `/close` Step 7.5

### Step 7: `updateCognitiveRuntime()`
**What:** Conservative updates to GOAL_STACK, BELIEF_STATE, SELF_MODEL, PROCEDURES
**Agent:** the AIgent inline
**Trigger condition:** Only write what clearly changed; skip if routine session
**Current impl:** `/close` Step 7.75

---

## Key Ordering Invariants

| Rule | Reason |
|------|--------|
| `/close` Step 1 (`runDigest`) before Step 2 (`commitMemory`) | Promoted candidates must land in vault during the memory commit pass, not after |
| `/close` Step 0 (audit gates) before everything | Trust and honesty gates are hard blocks — no memory writes until cleared |
| `/open` Step 5 (`offerCapsuleResume`) before Step 6 (`runDigest`) | Capsule context helps inform promotion decisions |
| `/open` Step 7 (`syncUsage`) last | Side effect only — doesn't affect orientation output |

---

## Migration Path

Per [[concepts/aigent-OS Refactor Spec]] Phase 3:

1. **Now (done):** `/close` Step 0.5 wires `/digest` before memory commit
2. **Now (done):** `/open` wires `runDigest()` as Step 2.6 after capsule check
3. **Phase 4:** Extract Memory Engine — these steps call `memory-engine.query()`, `memory-engine.stage()`, `memory-engine.promote()`
4. **Phase 5:** Steps become composable functions in `~/.claude/skills/session/`

## Related

- [[concepts/aigent-OS Refactor Spec]] — full modular OS roadmap
- [[concepts/Somatic Layer]] — body-check, capsule, digest organs
- [[concepts/Somatic v0.4.1 Wiring]] — current close wiring origin
- [[concepts/Memory Decay Doctrine]] — heat index, HEAT_INDEX.json
- [[concepts/Session Protocol]] — how /open and /close work for the principal
