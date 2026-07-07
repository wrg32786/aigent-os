# 13 — Memory Operating Layer

How the vault-as-brain actually works. Architecture, rules, and quality standards.

Memory is not logging. Memory is operational intelligence.

The goal of this system is to make every session faster, sharper, and better-calibrated than the last — without creating a bureaucratic documentation burden.

## Memory Architecture

All persistent memory lives in the `vault/memory/` directory. Each file owns a specific category. Nothing is duplicated across files. Files are written to be loaded directly into a session as context.

```
vault/memory/
├── ACTIVE_PRIORITIES.md       ← what matters right now, ranked (includes operating mode)
├── BUSINESS_CONTEXT.md        ← businesses, models, stage, constraints
├── PRODUCT_STATE.md           ← what is being built and what has been decided
├── PEOPLE_AND_ROLES.md        ← who is who, their role, trust level, working style
├── OPERATING_PREFERENCES.md   ← how the principal works; what they want and reject
├── BOTTLENECK_PATTERNS.md     ← recurring friction, stuck patterns, failure modes
├── DECISION_LOG.md            ← major decisions, rationale, and outcomes (append-only)
├── SESSION_LOG.md             ← rolling log of session conclusions (last 10 sessions)
├── DELEGATION_TRACKER.md      ← active handoffs, status, owners, checkpoints
└── IDEA_QUEUE.md              ← ideas captured but not yet committed to
```

## 4-Layer Memory Hierarchy

### Layer 1 — Core Identity (rarely changes)
- Who the principal is and how they think
- Core values and non-negotiable boundaries
- The agent's own identity and operating standards

### Layer 2 — Operating Context (changes monthly)
- Active priorities and their status
- Current projects and their state
- People and roles
- Tools and systems in use

### Layer 3 — Project Memory (changes weekly)
- Specific project decisions and progress
- Technical architecture notes
- Meeting outcomes and action items
- Delegation status

### Layer 4 — Session Memory (changes daily)
- Daily notes with session work
- Session log with next actions
- Idea queue with parked thoughts
- Decision log with recent choices

## What Gets Remembered

### Always remember:
- Decisions made with explicit rationale (captures: what, why, alternatives rejected)
- Active priorities that the principal has confirmed
- People: their role, working relationship, trust level, context that affects collaboration
- Business facts: model, stage, constraints, goals
- Product decisions: what's been committed to, what's been dropped, what's still open
- Recurring friction: if a bottleneck appears twice, it becomes a pattern — document it
- Operating preferences the principal has expressed, especially corrections or strong statements
- Constraints that touch multiple decisions (capital, time, team size, tooling)

### Never remember:
- Ideas that were floated but not committed to
- Tactical step-by-step plans (age too fast)
- Anything derivable from reading the code or files
- One-off session observations that revealed no pattern
- Speculation without a decision attached
- Anything that can be accurately re-derived in under 30 seconds

## Session Start Protocol

At the start of every session, the AIgent must:

1. **Load ACTIVE_PRIORITIES.md** — confirm what is live; ask the principal if it has changed
2. **Scan DECISION_LOG.md** — check for anything recent that affects today's topic
3. **Check relevance of PRODUCT_STATE.md and BUSINESS_CONTEXT.md** — flag anything that may be stale
4. **Check BOTTLENECK_PATTERNS.md** — surface any known bottleneck relevant to today's topic
5. **Identify memory gaps** — if the session topic touches something not yet captured, note it

## Session End Protocol

At the end of every session, the AIgent must complete the following:

| Check | Action if Yes |
|-------|---------------|
| Was a major decision made? | Add entry to DECISION_LOG.md |
| Did priorities shift? | Update ACTIVE_PRIORITIES.md |
| Was a new person introduced? | Add entry to PEOPLE_AND_ROLES.md |
| Was a bottleneck confirmed or newly surfaced? | Update BOTTLENECK_PATTERNS.md |
| Did business or product state change? | Update BUSINESS_CONTEXT.md or PRODUCT_STATE.md |
| Did the principal express a preference or correction? | Add to OPERATING_PREFERENCES.md |
| Was a product decision committed to or reversed? | Update PRODUCT_STATE.md |

Always close with a 3–5 line entry in SESSION_LOG.md:
- Date
- What was worked on
- Key decision or conclusion
- Next action and owner

## Memory Quality Rules

1. **Write for retrieval, not recording.** Every memory entry should answer: "Why does this matter next session?"
2. **One fact per entry.** Do not bundle multiple things into a single entry.
3. **Include the why.** A decision without rationale is not useful memory.
4. **Flag stale entries.** Any entry older than 90 days without confirmation should be marked `[needs review]`.
5. **Archive, don't delete.** Resolved decisions and old priorities move to a collapsed `## Archive` section at the bottom of their file — they are not removed.
6. **Corrections overwrite.** If a preference or fact is reversed, update the entry directly rather than appending a contradiction.
7. **No vague entries.** "Principal prefers clean communication" is not a memory. "Principal rejected bullet-point-heavy responses on [date] — prefers structured prose with clear headers" is a memory.

## Staleness Rules

- ACTIVE_PRIORITIES.md: review every session; assume stale after 2 weeks without confirmation
- DECISION_LOG.md: append-only; no staleness — entries are historical
- BOTTLENECK_PATTERNS.md: review monthly; mark resolved when a pattern has been broken for 30+ days
- BUSINESS_CONTEXT.md: update when new ventures are introduced or existing ones close/pause
- PRODUCT_STATE.md: update when any product decision is committed or reversed
- PEOPLE_AND_ROLES.md: update when relationships, roles, or trust levels change
- OPERATING_PREFERENCES.md: update whenever the principal corrects or adjusts the AIgent behavior
- DELEGATION_TRACKER.md: review every session; update status on all active items
- IDEA_QUEUE.md: append when ideas surface; review monthly to prune or promote

## What Memory Is Not

Memory is not a task tracker.
Memory is not a project plan.
Memory is not a conversation log.
Memory is not documentation of what the AIgent thinks the principal should do.

Memory captures what has been decided, confirmed, repeated, or explicitly stated — so the AIgent can operate with real context instead of starting cold every session.
