---
title: Decision Log
tags:
  - operations
  - decisions
---

# Decision Log

Append-only. Entries never deleted — only marked superseded. One entry per non-obvious decision that affects future plans.

**Entry format:**
```
### YYYY-MM-DD (Sxx) — [Title]
**Decision:** What was decided.
**Alternatives considered:** Other options on the table.
**Reasoning:** Why this won. What the losing options would have cost.
```

---

## Active Decisions

### 2026-04-25 (S47) — Pricing locked at $49/mo annual, $59/mo monthly
**Decision:** Keep Pro tier at $49/mo annual, $59/mo monthly. Don't raise to $59 annual.
**Alternatives considered:** (a) Raise annual to $59 to match monthly (pure simplification). (b) Drop monthly to $49 to encourage signups (revenue hit). (c) Status quo.
**Reasoning:** Annual/monthly differential of 17% is standard SaaS practice and our retention data shows annual-pre-pay customers churn 4× less. Simplification value < retention incentive value. Logged in [[Pricing Strategy]].

### 2026-04-23 (S45) — Education tier killed for this quarter
**Decision:** Don't ship an education tier. Tell university asks "not this quarter, possibly Q3."
**Alternatives considered:** (a) Ship a $19/student/yr tier with verification overhead. (b) Free for verified educators (revenue hit). (c) Defer.
**Reasoning:** Operational overhead of verification + support load doesn't pencil out at our 4-person scale. Revisit when team is 8+. The asks won't go away.

### 2026-02-14 (S31) — Usage-based pricing add-on shelved
**Decision:** No usage-based add-on for the Pro tier. Stay with flat-rate.
**Alternatives considered:** (a) $0.001/MAU above tier limit. (b) Tiered overage. (c) Hard cap with upgrade prompt.
**Reasoning:** Customer interviews showed our users prefer predictable bills. Billing complexity for us was real (Stripe metered billing setup, invoice reconciliation). The hard-cap-with-upgrade-prompt model achieves the same revenue effect without the complexity.

---

## Superseded Decisions (kept for context)

### 2025-Q4 — Pro tier at $29
**Superseded:** 2026-03-15 — migrated to $49 with grandfathered $35 rate.
**Why superseded:** Cohort analysis showed our users were getting >5x value at $29. Lifting to $49 was the right move; $35 grandfather kept existing customers happy.
