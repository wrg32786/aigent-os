# Nightly Self-Maintenance

> [!abstract] Core idea
> `/nightly` sequences the four already-shipped verbs named in the README's Roadmap -- `/dream`, `/reconcile`, `/sweep-now`, `/digest` -- into one named routine, with a `/system-check` gate and a ledger-review pass over the measurement layer (Honesty Ledger, Trust Decay, Failure Modes). It is a recipe for running that sequence on a cadence, not a new daemon: no background process ships with this, and nothing in the repo enforces that a schedule exists.

See `skills/nightly/SKILL.md` for the full protocol, cadence gates, and evidence-log schema. This doc covers running it.

## What it sequences

| Leg | Verb | Cadence gate | Evidence written |
|---|---|---|---|
| A | `/dream` | skip if last `DREAM_LOG.md` entry < 7 days old | candidates appended to `DREAM_LOG.md` |
| B | `/reconcile` | skip if `ACTIVE_STATE.json.last_reconcile` < 7 days old | report counts logged (reconcile itself writes nothing) |
| C | `/sweep-now` | skip if last `HESTIA_SWEEP_LOG.md` entry < 7 days old | Hestia's sweep result appended to `HESTIA_SWEEP_LOG.md` |
| D | `/digest` staging review | skip if zero `status: staged` rows | staged-candidate count logged (does not promote/skip/supersede) |
| E | `/system-check` | always runs | PASS/FAIL/INFO counts + exit code logged |
| F | Ledger review (Honesty Ledger / Trust Decay / Failure Modes) | always runs, scoped to new-since-last-pass | claims resolved via `/trust-decay resolve` (cited evidence only), 7d+ unresolved-pressure count, a `DREAM_LOG.md` candidate on a 2+ Pattern repeat |

### Leg F in more detail

Leg F reads the three measurement-layer ledgers the README's Cognitive architecture row already ships: `vault/memory/HONESTY_LEDGER.md`, `vault/memory/TRUST_DECAY.md`, and `vault/memory/FAILURE_MODES.md` (populated by `/honesty-check`, `/trust-decay`, and `/diagnose` respectively). It only looks at entries dated after the last `/nightly` pass, and it does three things: resolves an open claim only when confirming or disconfirming evidence already exists elsewhere in the vault (by invoking `/trust-decay resolve`, never by guessing); counts entries still unresolved after 7+ days as a pressure signal; and, if the same `FAILURE_MODES.md` Pattern line has now repeated 2+ times, stages one `DREAM_LOG.md` candidate for the operator to review through the normal `/dream`/`/meta-improve` gate. It never promotes a pattern straight to `[[Common Failure Modes]]` doctrine -- that stays `/skill-audit`'s job (and `/retro`'s once it ships) at the 3+ threshold -- and it never applies its own staged candidate. See `skills/nightly/SKILL.md`'s Leg F section for the full protocol. Leg F is only as useful as the ledgers are full, and what fills them is the `Stop` hook described in [Closing the Measurement Loop](closing-the-measurement-loop.md): without it the three ledgers stay empty and this leg has nothing to read.

Every leg -- run or skipped -- gets one line in `memory/runtime/NIGHTLY_LOG.md`. Nothing about the routine auto-applies a change: `/dream` and `/digest` remain exactly as human-gated as they are when run individually.

## Running it manually

```
/nightly
```

Optional flags (see `skills/nightly/SKILL.md`):

```
/nightly --skip dream
/nightly --only reconcile,system-check
```

## Running it on a schedule

aigent-OS has no built-in scheduler -- the [Roadmap](../README.md#-roadmap) lists "a generic recurring-task primitive" as future work, separate from this doc. Until that exists, the operator's own OS scheduler invokes Claude Code's non-interactive mode against the vault directory.

### macOS / Linux (cron)

```cron
# Run the aigent-OS nightly pass at 2:00 AM every day
0 2 * * * cd /path/to/your/vault && claude -p "/nightly" >> memory/runtime/nightly-cron.log 2>&1
```

`cd` into the vault directory first -- `/nightly` (like every skill in this repo) resolves its paths relative to the vault root, not to cron's default working directory.

### Windows (Task Scheduler)

Save as `nightly-task.ps1` inside the vault directory:

```powershell
Set-Location -Path $PSScriptRoot
claude -p "/nightly" *> "memory\runtime\nightly-cron.log"
```

Register it:

```powershell
schtasks /Create /SC DAILY /ST 02:00 /TN "AIgent Nightly Maintenance" `
  /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\your\vault\nightly-task.ps1"
```

Adjust `/ST` for your preferred time and the script path for your actual vault location.

## Honest caveats

- **No prior headless recipe exists in this repo to copy.** `claude -p "<prompt>"` is documented here on Claude Code's own non-interactive-mode contract, not on a pattern this repo already ships and tests. Verify it against your installed CLI version (`claude --help`) before relying on it unattended.
- **Permissions still apply.** Non-interactive mode does not bypass your `.claude/settings.json` permission rules. A `/nightly` run touches `Read`/`Write`/`Edit`/`Bash` across the legs above (see each leg's `allowed-tools` in its own `SKILL.md`); run `/nightly` once interactively first so any permission prompts surface while you're there to answer them, before you schedule it unattended.
- **This is a recipe, not a daemon.** Nothing in this repo verifies the cron entry or scheduled task still exists, still points at the right path, or ever actually fires. If a run silently stops happening, `memory/runtime/NIGHTLY_LOG.md`'s last date is the way to notice -- there is no alerting.
- **One-shot process.** `claude -p` starts, runs `/nightly`, and exits. No session state persists between nightly runs beyond what the routine itself reads and writes in the vault.
- **API usage still applies.** An unattended nightly run consumes the same usage as any other session. `/nightly`'s own work is orchestration and log-writing, not heavy generation -- a cheaper model tier is a reasonable choice for a scheduled run if your setup lets you pin one.
