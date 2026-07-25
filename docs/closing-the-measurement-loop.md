---
title: Closing the Measurement Loop
tags: [doctrine, measurement, honesty, calibration]
aliases: [discipline-check, ledger trigger]
created: 2026-07-25
---

# Closing the Measurement Loop

> [!abstract] Core idea
> aigent-OS ships three measurement ledgers and three skills that write them, but until now nothing ever *asked* for a write. `daemons/discipline-check.mjs` is the missing trigger: a `Stop` hook that notices when a turn made confident claims and no ledger recorded them.

## The gap this closes

The measurement layer is three files and three verbs:

| Ledger | Written by | Records |
|---|---|---|
| `vault/memory/HONESTY_LEDGER.md` | `/honesty-check` | what changed, what did not, what was guessed, what was traded away |
| `vault/memory/TRUST_DECAY.md` | `/trust-decay` | a confident claim (Phase 1), later resolved right or wrong (Phase 2) |
| `vault/memory/FAILURE_MODES.md` | `/diagnose` | a root cause and the one-line pattern it belongs to |

Every one of those verbs is operator-invoked. That is the correct design for the *write*: only a skill that has read the actual work can compose an honest entry, and a hook that guessed at one would poison the record it exists to protect. But it leaves the loop open at the other end. Nothing observes that a claim was made, so nothing ever prompts the capture, so on a fresh install all three ledgers stay exactly as they shipped: structure, no data.

That failure mode is quiet and it is worse than shipping no measurement at all. The files exist. The skills exist. The README says calibration is measured. An operator six months in has three empty ledgers and no signal that anything was ever wrong, which is indistinguishable from three ledgers that say the agent was never wrong.

## What the hook does

A `Stop` hook, matcher `""`, so it sees the end of every turn. On each turn it:

1. Reads the assistant's own last message from the hook payload.
2. Strips fenced code blocks and inline code spans. A `works` inside a pasted snippet or a test name is not a claim about the work, for the same reason the repo's em-dash guard exempts code.
3. Counts unhedged confident verbs in what remains: `fixed`, `verified`, `tested`, `deployed`, `complete`, `shipped`, `ready`, `merged`, `passing`, `works`.
4. Checks how long it has been since any of the three ledgers was written.
5. If the count crosses the threshold *and* no ledger has been written recently, prints one advisory line naming the verb that would capture it.

Both halves of that condition matter. The verb count alone would fire constantly on a productive turn. The staleness check alone would fire on quiet turns that claimed nothing. Together they isolate the case the ledgers were built for: this turn asserted several verified end states, and none of them entered the record.

## What it deliberately does not do

**It never blocks.** Advisory only, exit 0, always. Same posture and the same reasoning as [Model-Tier Routing Enforcement](model-routing-enforcement.md): a hook that interrupts on a guess trains operators to ignore it the first time it fires wrong.

**It never writes a ledger.** The skills own their entry formats. This hook's entire job is to make the moment visible.

**It never echoes what it read.** The nudge carries a count and nothing else. The scanned message is not logged, not persisted, and not repeated back, which is the same discipline `hooks/tool-tracker.js` applies to captured tool metadata.

## Tuning

| Variable | Default | Effect |
|---|---|---|
| `AIGENT_DISCIPLINE_CHECK` | unset | set to `off` to disable the hook entirely |
| `AIGENT_DISCIPLINE_THRESHOLD` | `3` | confident claims in one turn before it fires |
| `AIGENT_DISCIPLINE_QUIET` | `300` | seconds since the newest ledger write before it fires |

Raise the threshold if it fires on turns you consider ordinary. Lower it during a period you want tightly measured. Setting it to `1` captures essentially every claim, which is useful for a week of calibration work and exhausting as a permanent posture.

If no ledger file exists at all, the staleness check treats that as maximally stale: nothing has ever been captured, which is exactly when the prompt is most warranted.

## Reading the record it produces

The ledgers only become useful once they have entries to compare. `/nightly`'s Leg F is the intended reader: it resolves open Trust Decay claims against evidence already in the vault, counts claims still unresolved after a week as a pressure signal, and stages a `DREAM_LOG.md` candidate when the same failure pattern repeats. See [Nightly Self-Maintenance](nightly-self-maintenance.md).

The number worth watching is not the entry count. It is the ratio of Phase 1 captures that later resolve as confirmed. If that ratio climbs over months, the framework is doing its job. If it falls, something is rotting and the ledgers will say which layer.

## Related

- `daemons/discipline-check.mjs`, the hook itself
- `daemons/tests/discipline-check.test.mjs`, its contract
- `vault/concepts/Cost of Confidence.md`, the doctrine behind Trust Decay
- `vault/concepts/Suggestion Credibility.md`, why this advises instead of blocking
