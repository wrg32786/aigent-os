# Nightly Close-Parity Maintenance

`/nightly-close-parity` runs the same durable maintenance expected at a careful
session close, but with machine-checked evidence around every checkpoint. It is
safe for a single-user installation: no message bus, task board, database, or
external coordinator is required.

The protocol has seven framework legs and eleven checkpoints:

| Leg | Checkpoints |
|---|---|
| Dream | `dream` |
| Reconcile and context | `reconcile`, `context-hygiene` |
| Sweep and heat | `sweep-now`, `heat-index` |
| Digest | `digest` |
| Runtime health | `system-check`, `cognitive-runtime` |
| Measurement ledgers | `ledger-capture`, `ledger-review` |
| Vault sync | `vault-sync` |

The complete behavioral contract lives in
[`skills/nightly/SKILL.md`](../skills/nightly/SKILL.md). The unique public fire
verb lives in
[`skills/nightly-close-parity/SKILL.md`](../skills/nightly-close-parity/SKILL.md).

## Why the unique fire verb exists

Skill runtimes may also have user-installed skills with common names. The
nightly route therefore resolves `/nightly` and `/nightly-close-parity` to the
top-level project skill carrying this sentinel:

```text
NIGHTLY_LOCAL_PROTOCOL: close-parity-v2-7L-11C
```

Before a pass starts, the route checker verifies that exact local skill:

```bash
node daemons/nightly-route-check.mjs --root "$AIGENT_ROOT"
```

It must print `NIGHTLY_ROUTE PASS`. A missing or altered target fails closed;
the router does not fall back to an ambiguous writer.

## Evidence model

The controller in `daemons/nightly-pass.mjs` owns pass state and evidence. A
checkpoint records:

- its canonical name;
- `PASS`, `SKIPPED`, or `FAIL`;
- the literal process exit code;
- a bounded detail;
- a canonical file, stdout, Git, or allowlisted-none artifact;
- the independent validator receipt.

Only `sweep-now` and `digest` may be skipped, and only when their predicates can
be reproduced from current canonical input. Missing input is a failure.

The terminal evidence block is appended to:

`vault/memory/runtime/NIGHTLY_LOG.md`

A terminal block is green only when all eleven checkpoint rows appear exactly
once, every validator receipt is present, no checkpoint failed, no exit is
nonzero, and terminal `status: PASS` is present. A terminal `status: FAIL` is
always red, even when every row exists.

## Postconditions

A checkpoint cannot certify itself by printing the artifact string it expects.
The controller re-derives each result:

- Dream and cognitive files retain their pre-fire prefix and valid append-only
  suffixes.
- Reconciliation and context hygiene rerun deterministic validators.
- The sweep cadence comes from the newest real dated sweep-log header.
- The heat index is parsed after atomic replacement and must carry a current
  `generated_at`.
- Digest staged-row counts are re-parsed from the canonical table.
- System health reruns with explicit root and date policy.
- Ledger capture and review are checked against their begin snapshots.
- A clean vault-sync result is accepted only when a fresh Git predicate
  reproduces it.

Judgment-bearing changes remain staged for the operator. Dream proposals begin
as `proposed`; digest never promotes unattended; reconciliation never
reprioritizes; ledger proposals do not resolve themselves; meta-improvement
requires exact approval evidence.

## Alerts without external infrastructure

Named alerts are append-only events in:

`vault/memory/runtime/NIGHTLY_ALERTS.jsonl`

The local delivery path is complete:

1. The alert event is written before delivery is reported.
2. A bounded alert is written to stderr.
3. Active alerts are printed by `daemons/sessionstart-reinject.mjs` at the next
   session start.

An unavailable optional integration cannot fail a leg and cannot turn delivery
into a silent no-op. The ledger and local surfaces remain authoritative. This
installation does not report fires to a task board.

SessionStart also runs the watchdog as a durable fallback for installations
without a scheduler. A missed fire is appended to the local ledger, delivered
on stderr, and surfaced in the normal hook payload; repeat starts deduplicate the
same active alert. This alert path is isolated from normal orientation and
resume. An unreadable or malformed alert ledger surfaces
`NIGHTLY-ALERT: ALERT_LEDGER_INVALID` (or a bounded surface failure), logs the
read error locally, continues the normal payload, and exits `0`.

## No-fire watchdog

`daemons/nightly-watchdog.mjs` reads the actual newest
`## Nightly Pass -- YYYY-MM-DD` header outside fenced examples. It ignores file
mtime, applies the configured timezone and cutoff, then validates the selected
terminal block.

Run it without mutation:

```bash
node daemons/nightly-watchdog.mjs \
  --root "$AIGENT_ROOT" \
  --check-only \
  --no-deliver \
  --verbose
```

Run it normally from a scheduler to append or resolve the matching local alert.
A current date header with incomplete evidence or terminal `status: FAIL`
remains red.

## One date policy

Pass dating, alert scopes, ledger review, system checks, and watchdog freshness
share one configurable timezone and cutoff:

```bash
export AIGENT_NIGHTLY_TIME_ZONE="America/Los_Angeles"
export AIGENT_NIGHTLY_CUTOFF_HOUR="4"
```

Those are the defaults. A scheduled run may choose another IANA timezone and
cutoff, but it must pass the same values to every leg. Date-sensitive
controller and watchdog fixtures pin both values and the current instant;
SessionStart fixtures pin the roots and date policy and assert relative hook
behavior.

## Memory roots and safe probes

Normal operational memory lives under `vault/memory`. Minimal forks may use the
documented `memory` fallback. `AIGENT_STATE_HOME_DIR` diverts the same lookup to
a disposable tree before either location is considered.

Tests and isolation probes should set:

```bash
export AIGENT_ROOT="/path/to/aigent-os"
export AIGENT_STATE_HOME_DIR="/path/to/disposable-state"
export AIGENT_NIGHTLY_TIME_ZONE="America/Los_Angeles"
export AIGENT_NIGHTLY_CUTOFF_HOUR="4"
```

Mutation-proof suites use operating-system temp directories. They do not write
to a real vault.

## Running manually

From the aigent-OS root:

```text
/nightly-close-parity
```

Run once interactively before scheduling so local tool permissions and
repository authority are understood. The pass does not weaken any existing
human gate.

## Scheduling

aigent-OS does not install an operating-system scheduler. The examples below
are recipes, not proof that a schedule exists.

### macOS or Linux

```cron
0 2 * * * cd /path/to/aigent-os && AIGENT_ROOT="$PWD" claude -p "/nightly-close-parity" >> vault/memory/runtime/nightly-cron.log 2>&1
```

### Windows Task Scheduler

Save this as `nightly-task.ps1` in the aigent-OS root:

```powershell
Set-Location -Path $PSScriptRoot
$env:AIGENT_ROOT = $PSScriptRoot
claude -p "/nightly-close-parity" *> "vault\memory\runtime\nightly-task.log"
```

Register that script with Task Scheduler using the desired local time. Verify
the scheduled command against the installed CLI before relying on it.

## Verification

Run:

```bash
bash daemons/system-check.sh
```

The system check parses every nightly daemon, validates the canonical Dream
header, runs the watchdog in check-only mode, and proves the unique route. It
does not append or resolve nightly alerts.

Every hardened check has a mutation proof: the test breaks the predicate,
captures a real red process result, restores the fixture, and captures green.
The suite includes a real terminal `status: FAIL` fixture. BREAK and RESTORE
lines are interpolated from those process results rather than written as
decorative text.

## Operational boundaries

- The pass never auto-approves, auto-promotes, or self-merges.
- It never treats a missing canonical input as an empty-success case.
- It never force-pushes, rewrites history, resolves Git conflicts, or includes
  unrelated user work.
- Repository sync runs only under configured authority.
- Installation seeds only missing, empty nightly schema templates and never
  fires the pass or overwrites operational state. Tests divert all writes to
  operating-system temp fixtures.
