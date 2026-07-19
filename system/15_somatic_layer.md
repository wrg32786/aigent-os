---
title: Somatic Layer — Body State Doctrine
tags: [somatic, body-state, memory, doctrine, v0.4]
aliases: ["somatic", "body state", "15_somatic"]
created: 2026-05-02
status: active
version: "0.4"
---

# 15 — Somatic Layer

> [!abstract] One-line summary
> The AIgent now has a body: a single on-demand read of "how am I doing?" computed from signals that already exist, not from a new polling daemon.

## Why somatic

The AIgent already has anatomy: a kernel (system docs 00–14), memory (the `memory/` directory), hooks (Caddy), and skills. What was missing was **body state** — a unified read of operational pressure across all five dimensions at once.

Without body state, "how am I doing?" is vibes. With body state, it's thresholds. The difference is whether instincts are informed or guessed.

Body state does not add new data. Every field it reports already lives somewhere — HEAT_INDEX, DECISION_LOG, DELEGATION_TRACKER, usage_log. The somatic layer is a reading layer, not a storage layer.

## The five pressures

| Pressure | Signal source | Threshold concern |
|----------|--------------|-------------------|
| **Context** | Tool call count + token usage estimate | High/critical = capsule now |
| **Memory** | `MEMORY_CANDIDATES.md` staged count | >10 staged = run /digest |
| **Decision** | `DECISION_LOG` vs `DECISION_OUTCOMES` (30/60/90d) | Overdue reviews surface in /open |
| **Token** | `usage_log.md` latest vs trailing-5 average | High = route cheaper, defer haiku work |
| **Attention** | /open attention reconciliation result | True = drift active, reanchor first |

Each pressure has a measurable signal. Each has a threshold that triggers a recommended reflex. The reflexes are: `digest`, `capsule`, `compact`, `close`, `sweep`, `none`.

## Lazy compute, not polling

Body state is computed **on demand** by `/body-check`. It is not maintained by a daemon, not written on a cron, not polled between turns.

The AIgent is session-bounded. A daemon that polls between sessions would run against nothing. The signals it would read already have their own custodians (Hestia sweeps every 7 days; /open reads ACTIVE_PRIORITIES on boot). Body state is the intersection layer — it reads those signals and surfaces a composite at a moment the principal actually needs it.

> [!info] Rule
> NEVER schedule BODY_STATE.json writes. Only `/body-check` may write to `state`. Reads are always free.

## Computed summary, not duplicate state

If a fact already lives in a source file, BODY_STATE.json does not restate it. It reads from the source and reflects a computed field.

Example: `delegation_open_count` is not stored in BODY_STATE.json as a running total. `/body-check` counts open items in `DELEGATION_TRACKER.md` at invocation time and writes the count to `state`. On the next `/body-check`, it recomputes from scratch.

This means BODY_STATE.json can go stale between invocations — that is intentional. A stale body state is not a bug; it is a signal that `/body-check` hasn't run recently.

## Block schema doctrine

*Lifted from Letta's block metadata pattern.*

Every field in `BODY_STATE.json` has explicit metadata in `_schema`:

| Metadata key | Purpose |
|---|---|
| `type` | Data type: `enum`, `int`, `bool`, `iso8601 \| null` |
| `values` | For enums: allowed values |
| `limit` | For ints: threshold that triggers concern |
| `source` | Exactly where this value comes from |
| `read_only` | Always `true` — `/body-check` computes, never manually edits |

Fields cannot be added to `state` without a corresponding `_schema` entry and a version bump. No freeform blobs in body state.

## Hot-path vs background discipline

*Lifted from LangMem's memory architecture.*

Two speeds of memory work:

**Hot-path (write-time):** During a session, when something worth remembering surfaces — a decision, a preference, a "from now on" — write it to `MEMORY_CANDIDATES.md` immediately. This write is **free and uncurated**. No friction. Caddy can suggest it. Auto-capture can append it. The principal can dictate it in one line.

**Background (digest-time):** Curation happens at `/digest`, not at write-time. `/digest` is when the principal reviews staged candidates and decides: promote / skip / supersede. This is deliberate and infrequent (at /close, on Hestia's 7-day cadence, or when backlog > 10).

> [!danger] Anti-pattern
> Do NOT second-guess whether a candidate is worth writing at capture time. That is curation pressure applied at the wrong moment. Write first, curate at /digest.

## Distillation triggers

*Lifted from Acontext's distillation architecture.*

`/context-capsule` fires on **two conditions**, not one:

1. **Pressure trigger** — context_pressure reaches medium or higher, OR session_age > 90 minutes, OR tool_call_count > 80
2. **Completion trigger** — a task ships, a thread closes, a milestone hits

The completion trigger is why capsules become structurally meaningful instead of emergency-only. A capsule written at task completion captures what was actually accomplished and what threads are open — not just "I'm running out of context."

Emergency capsules (pressure-only) are often poorer in signal because they interrupt mid-thought. Completion-triggered capsules are richer and more useful as session pickups.

## Autonomy gates

What the somatic skills may do **without approval**:

- Read any file in `memory/`, `system/`, `concepts/`
- Append candidates to `MEMORY_CANDIDATES.md`
- Write `state` to `BODY_STATE.json` (computed, not authored)
- Surface recommended reflex as a suggestion (not a command)
- Write capsule files to `memory/capsules/`

What requires **the operator's explicit word**:

- Promote a candidate to a vault note (via /digest)
- Supersede an existing vault entry
- Mutate doctrine (any `system/` doc)
- Mark a decision as reversed in DECISION_LOG

The boundary is: reads and accumulation are autonomous; promotion and mutation require the principal.

## What this is NOT

- Not agent fitness tracking (that's v0.5, pending real failure volume)
- Not a sleep daemon or health monitor for agent instances
- Not a polling system — nothing runs between turns
- Not a duplicate of HEAT_INDEX, ACTIVE_PRIORITIES, or DELEGATION_TRACKER
- Not Hestia's job — Hestia sweeps the vault on a 7-day cadence; somatic reads state mid-session on demand

## Cross-links

- [[concepts/Memory Decay Doctrine]] — decay thresholds that HEAT_INDEX uses; somatic reads from HEAT_INDEX
- [[memory/HEAT_INDEX]] — attention/decay state; source for `attention_drift_active`
- [[concepts/Pipeline Verification Doctrine]] — verify signals exist in source before reporting them
- [[agents/Hestia]] — Hestia owns the 7-day custodial sweep; somatic is the mid-session read; they are complementary, not redundant
- [[memory/BODY_STATE.json]] — the schema this doctrine governs
- [[memory/MEMORY_CANDIDATES.md]] — the staging buffer governed by hot-path/background discipline above
