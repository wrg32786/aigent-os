---
name: nightly
agent: none
description: One evidence-gated pass that sequences /dream, /reconcile, /sweep-now, and /digest over your own vault, with a /system-check gate and a ledger-review pass over the measurement layer (Honesty Ledger, Trust Decay, Failure Modes). Stays exactly as human-gated as the legs it calls -- stages, never auto-applies. Skips a leg gracefully when there is nothing to do; every leg that runs leaves an evidence line.
allowed-tools: Read, Write, Edit, Bash
user-invocable: true
triggers:
  - nightly
  - night pass
  - self-maintenance
  - maintenance pass
  - dream log review
  - nightly routine
  - maintenance sweep
  - /nightly
---

# /nightly -- Nightly Self-Maintenance

> [!danger] Same gate as every leg it calls
> `/nightly` does not lower the bar any leg already holds itself to. `/dream` still only proposes -- candidates land in `DREAM_LOG.md` as `status: proposed`, the operator still promotes them through `/meta-improve`. `/digest` still only stages -- candidates stay `status: staged` until the operator answers promote/skip/supersede. `/sweep-now` still only proposes tracker/heat/link fixes for review. `/nightly` itself writes less than any leg it calls: one line per leg, to its own log, and nothing else.

Sequences the four already-shipped verbs named in the README's Roadmap -- `/dream`, `/reconcile`, `/sweep-now`, `/digest` -- into one named routine, with a `/system-check` gate and a ledger-review pass over the measurement layer, so a vault gets a maintenance pass on a cadence instead of only when the operator remembers to run each piece by hand.

## Invocation

```
/nightly
/nightly --skip dream                    # run every leg except one
/nightly --only reconcile,system-check   # run a subset
```

---

## What it sequences

Six legs, run in order. Each leg is gated by the cadence its own skill already documents -- `/nightly` does not invent a new cadence, it just checks the one that already exists before deciding whether a leg has anything to do.

### Leg A -- `/dream` consolidation

Run the full protocol in `skills/dream/SKILL.md` (Steps 1-5): load daily notes + runtime state, run the six analysis passes, append any candidates to `DREAM_LOG.md` with `status: proposed`.

**Cadence gate:** skip if the most recent `## Dream Run` header in `DREAM_LOG.md` is less than 7 days old -- matches `/dream`'s own Caddy Enrollment cadence ("Weekly on /close, if last run > 7 days"). Running the same 7-day source window twice a night apart produces near-duplicate candidates, not new signal.

**Never:** promotes a candidate, edits CLAUDE.md, or touches anything besides appending to `DREAM_LOG.md` -- exactly per `/dream`'s own "What /dream Never Does" section.

### Leg B -- `/reconcile`

Run the full protocol in `skills/reconcile/SKILL.md` (Checks A-G against `ACTIVE_STATE.json`, `GOAL_STACK.json`, `BELIEF_STATE.jsonl`, `SELF_MODEL.json`, `ACTIVE_PRIORITIES.md`, `LESSONS.jsonl`, `facts.jsonl`, `SKILL_GAPS.md`, `DELEGATION_TRACKER.md`, `BODY_STATE.json`). `/reconcile` is read-only by its own design -- it prints a report and modifies no runtime file.

**Cadence gate:** skip if `ACTIVE_STATE.json`'s `last_reconcile` field is less than 7 days old -- matches `/reconcile`'s own Caddy Enrollment cadence.

**Never:** modifies `ACTIVE_STATE.json`, `GOAL_STACK.json`, beliefs, or facts. The report's summary counts (contradictions / stale items / drift / orphans) become this leg's evidence line, since `/reconcile` itself persists nothing.

### Leg C -- `/sweep-now`

Invoke `/sweep-now` exactly as `skills/sweep-now/SKILL.md` specifies: it dispatches Hestia (sonnet) to run all three vault sweeps -- `DELEGATION_TRACKER` stale items, `HEAT_INDEX` dormant flips, broken wikilinks -- and appends the result to `HESTIA_SWEEP_LOG.md`.

**Cadence gate:** skip if the most recent `### YYYY-MM-DD` header in `HESTIA_SWEEP_LOG.md` is less than 7 days old -- matches Hestia's own default cadence in `skills/sweep-now/SKILL.md`.

This reuses the shipped `/sweep-now` verb as-is rather than re-implementing wikilink and tracker scans inline -- it is a real skill in this repo (`skills/sweep-now/SKILL.md`, `skills/sweep-links/SKILL.md`, `skills/sweep-tracker/SKILL.md`), and it is the exact verb the README's own Roadmap line names for this routine.

### Leg D -- `/digest` staging review

A lighter pass than the full `/digest` skill, deliberately. `/digest` ends in an interactive promote/skip/supersede exchange with the operator -- there is no operator present during an unattended nightly run to answer it, and `/nightly` never simulates an answer on the operator's behalf. So this leg only:

1. Reads `MEMORY_CANDIDATES.md`.
2. Counts rows with `status: staged`, grouped by `type` (decision / preference / doctrine / project / person / skill) exactly as `/digest`'s own Step 2 groups them.
3. Records the count and grouping as this leg's evidence line, for the operator to run the real `/digest` against at their next session.

**Cadence gate:** skip if there are zero `status: staged` rows.

**Never:** promotes, skips, or supersedes a candidate. That stays `/digest`'s job, on the operator's word, per its own "NEVER auto-promote" rule.

### Leg E -- `/system-check`

Run `bash daemons/system-check.sh` from the vault root, exactly as `skills/system-check/SKILL.md` specifies. Capture the PASS/FAIL/INFO counts and exit code as this leg's evidence line.

**Cadence gate:** none -- always runs. It is a read-only smoke test that completes in under 5 seconds per its own doctrine, so there is no cost to running it every night, and a FAIL here is exactly the kind of thing a nightly pass should never skip past silently.

### Leg F -- Ledger review (Honesty Ledger / Trust Decay / Failure Modes)

Cross-references the three measurement-layer ledgers `/honesty-check`, `/trust-decay`, and `/diagnose` already populate: `vault/memory/HONESTY_LEDGER.md`, `vault/memory/TRUST_DECAY.md`, `vault/memory/FAILURE_MODES.md`. Scope is new-since-last-`/nightly`-pass only -- entries dated after the most recent `## Nightly Pass` header in `NIGHTLY_LOG.md` -- read against each ledger's own actual schema, not a new nightly-invented vocabulary.

1. **Resolve what's already knowable.** For each `TRUST_DECAY.md` entry still in the `## Open (awaiting outcome)` section, and each `HONESTY_LEDGER.md` entry with `**Resolution:** OPEN`, check whether unambiguous confirming or disconfirming evidence already exists elsewhere in the vault (a later daily note, a session capsule, or a matching `FAILURE_MODES.md` entry). If it does, invoke `/trust-decay resolve` exactly per its own Phase 2 format -- `**Resolution (YYYY-MM-DD):** WRONG | PARTIALLY WRONG | CONFIRMED CORRECT` plus `**Evidence:**` citing the source -- which per `/honesty-check`'s own doctrine pairs and updates both ledgers together. If no unambiguous evidence exists, leave the entry open; it counts toward step 2 instead. This never invents a resolution -- it only applies one that is already documented somewhere else in the vault.
2. **Count the pressure.** Count entries still unresolved after 7+ days: `TRUST_DECAY.md` Open-section entries, `HONESTY_LEDGER.md` entries with `Resolution: OPEN`, and -- since `FAILURE_MODES.md` has no open/resolved concept of its own -- `Pattern frequency tracker` patterns that reached count 3+ but have not yet been promoted to `[[Common Failure Modes]]` doctrine. This total is the pressure signal in the evidence line; a rising count means calibration data is piling up unreviewed.
3. **Stage a candidate on a repeat.** Scan `FAILURE_MODES.md` Phase 1 entries new since the last `/nightly` pass for a `Pattern` line that now appears 2+ times. If found, stage one candidate into `DREAM_LOG.md` using `/meta-improve`'s own required candidate schema (`status: proposed`, `change_type`, `target`, `proposed_change`, `rationale`, `risk`, `proposed_by: aigent` -- noting `/nightly` leg F as the source in the rationale) -- staging only, exactly as operator-gated as every other `/dream` candidate. `/nightly` never runs `/meta-improve` itself.

This overlaps by design with `/dream`'s own Pass A, which also scans `FAILURE_MODES.md` for a 2+ repeat -- but Pass A only runs on Leg A's 7-day cadence, so on a night Leg A is skipped, this is the only thing still watching for a fresh repeat between dream passes. It is also distinct from `FAILURE_MODES.md`'s own built-in 3+ promotion path (`/skill-audit` or `/retro` walking the Pattern frequency tracker straight to `[[Common Failure Modes]]` doctrine) -- this leg proposes a `DREAM_LOG.md` candidate at the lower 2+ bar, through the dream/meta-improve gate, not a direct doctrine promotion.

**Cadence gate:** always runs; scope is bounded to new-since-last-pass rather than skipped outright, since a zero-new-entries night is the common case and gets recorded as such, not silently passed over.

**Never:** invokes `/trust-decay resolve` without citable evidence already in the vault. Never promotes a pattern straight to `[[Common Failure Modes]]` doctrine -- that stays `/skill-audit`'s job (and `/retro`'s once it ships) at the 3+ threshold. Never applies a staged candidate -- that stays `/meta-improve`, on the operator's approval.

---

## Evidence log

Every leg -- run or skipped -- gets one line appended to `$AIGENT_VAULT/memory/runtime/NIGHTLY_LOG.md`. This file is `/nightly`'s only direct write, with one exception: leg F stages a `DREAM_LOG.md` candidate itself when it sees a repeated failure pattern, since the leg that normally owns that file (`/dream`, leg A) may have been skipped. It does not exist until the first `/nightly` run creates it; do not pre-seed it.

```markdown
## Nightly Pass -- {YYYY-MM-DD}
Legs run: {N}/6 | Legs skipped: {N}

- dream: {ran -- N candidates appended to DREAM_LOG.md | skipped -- last run {X}d ago (<7d cadence)}
- reconcile: {ran -- N contradictions, N stale, N drift, N orphans | skipped -- last run {X}d ago (<7d cadence)}
- sweep-now: {ran -- see HESTIA_SWEEP_LOG.md entry {date} | skipped -- last run {X}d ago (<7d cadence)}
- digest: {ran -- N candidates staged across {types} | skipped -- 0 staged}
- system-check: {N PASS / N FAIL / N INFO -- exit {0|1}}
- ledger-review: {N resolved via /trust-decay resolve (cited evidence) / N unresolved 7d+ pressure / N candidate(s) staged to DREAM_LOG.md | no new ledger entries since last pass}

---
```

Do NOT overwrite -- always append with a new date header, matching `DREAM_LOG.md`'s own convention.

---

## What `/nightly` Never Does

- Does not promote a memory candidate, approve a dream candidate, or apply a sweep fix -- every human gate the legs already have stays exactly where it is.
- Does not write to `MEMORY_CANDIDATES.md`, `HESTIA_SWEEP_LOG.md`, `TRUST_DECAY.md`, `HONESTY_LEDGER.md`, or any runtime state file directly. Only the leg being invoked writes there, under that leg's own contract. The one exception is leg F's staged `DREAM_LOG.md` candidate, which leg F writes itself precisely because leg A may not have run.
- Does not resolve a trust-decay or honesty-ledger claim without evidence already documented elsewhere in the vault -- Leg F only invokes `/trust-decay resolve` where a citation already exists.
- Does not promote a failure pattern straight to `[[Common Failure Modes]]` doctrine -- that stays `/skill-audit`'s job (and `/retro`'s once it ships) at the 3+ threshold.
- Does not run `/meta-improve`. Turning a dream candidate into a real change stays a separate, manual step.
- Does not invent a cadence. Every skip decision cites a cadence a sibling skill already documents.
- Its own write surface is `NIGHTLY_LOG.md`, plus one staged `DREAM_LOG.md` candidate when leg F sees a repeated failure pattern -- every other write happens because `/nightly` invoked an already-shipped skill's own action, under that skill's own contract.

---

## When to run

- On a schedule -- see `docs/nightly-self-maintenance.md` for the cron and Windows Task Scheduler recipes.
- Manually, any time, via `/nightly`.
- Never fires automatically from inside a running session -- there is no hook wiring this to `Stop` or `SessionEnd`. It is either typed or scheduled.

---

## Caddy Enrollment

Caddy fires this skill when:
- User types `/nightly`
- Message contains "nightly pass", "self-maintenance", "maintenance pass", "maintenance sweep", or "dream log review"

See [[concepts/Cognitive Architecture Roadmap]] · `docs/nightly-self-maintenance.md` · `skills/dream/SKILL.md` · `skills/reconcile/SKILL.md` · `skills/sweep-now/SKILL.md` · `skills/digest/SKILL.md` · `skills/system-check/SKILL.md` · `skills/honesty-check/SKILL.md` · `skills/trust-decay/SKILL.md` · `skills/diagnose/SKILL.md`
