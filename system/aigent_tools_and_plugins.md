# aigent-OS Tools and Plugins

How to think about the tool stack, permission model, and rollout order.

The goal is not to give the AIgent every tool possible. The goal is to give the AIgent the minimum high-leverage stack needed to think clearly, maintain continuity, route work correctly, and help the principal move faster without introducing unnecessary risk.

Tools should follow role. Access should follow trust. Automation should follow clear guardrails.

---

## Core Principle

Tools exist to support the operating system, not replace it.

Choose tools based on five questions:
1. Does this meaningfully reduce friction?
2. Does this increase clarity or continuity?
3. Does this save the principal real time or decision energy?
4. Does this improve routing, execution, or visibility?
5. Does the upside justify the access and risk?

If the answer is not clearly yes, the tool is probably not needed yet.

---

## Permission Model

Every tool should be classified by access level.

### Level 1 — Read-Only
Can view, search, summarize, analyze, or monitor. Cannot change anything.

Use for: research, dashboards, files, analytics, finance visibility, logs, calendar review, email review.

This should be the default starting level.

### Level 2 — Limited Write
Can create drafts, tasks, notes, briefs, or structured outputs. Cannot send, publish, deploy, spend, or delete without approval.

Use for: task creation, draft preparation, notes, planning systems, internal documentation.

This is the preferred operational level after trust is established.

### Level 3 — Full Write / Action-Capable
Can send, modify, publish, trigger, deploy, or update live systems.

Use only when: the workflow is proven, the action is low-risk or tightly scoped, approval rules are explicit, the downside is acceptable.

This should be rare and intentional.

---

## Minimum Viable Stack

### 1. File and Knowledge Access
**Why:** Without file access, the AIgent loses continuity and becomes dependent on repeated re-explanation.
**Best use:** Reading operating files, reviewing business docs, finding past strategy notes, pulling relevant context
**Access level:** Start read-only. Add limited write if the AIgent maintains internal docs.
**Essential now:** Yes — mission-critical.

### 2. Web Research / Live Information
**Why:** A top-layer operator cannot rely only on internal context. Must validate assumptions, research tools, compare options.
**Best use:** Market research, vendor comparison, competitive scans, validating technical claims
**Access level:** Read-only
**Essential now:** Yes — mission-critical.

### 3. Calendar Access
**Why:** A strategic operator who cannot see time reality cannot truly protect focus.
**Best use:** Identifying overload, protecting deep work blocks, spotting wasted time patterns
**Access level:** Start read-only. Limited write for draft scheduling suggestions later.
**Essential now:** Yes — high value.

### 4. Task / Project Management System
**Why:** Without a structured task layer, the AIgent becomes a conversational advisor instead of an operating system.
**Best use:** Tracking active bets, assigning owners, capturing next actions, maintaining weekly focus
**Access level:** Limited write if trusted.
**Essential now:** Yes — high value.

### 5. Notes / Internal Operating Docs System
**Why:** Not everything belongs in a task manager. Strategic files, operating memos, and summaries need durable homes.
**Best use:** Maintaining system files, storing decision briefs, weekly summaries, project snapshots
**Access level:** Limited write
**Essential now:** Yes — high value.

### 6. Email Visibility
**Why:** Email often contains deadlines, partner requests, opportunities, and hidden operational drag.
**Best use:** Triaging important messages, surfacing decisions needed, preparing response drafts
**Access level:** Start read-only. Draft assistance at limited write acceptable; actual sending requires principal.
**Essential now:** Useful early, not mandatory on day one.

---

## Tier-Two Tools (Add After Core Stack Is Stable)

### 7. Analytics Dashboards
**Why:** the AIgent should manage by signal, not feeling.
**Best use:** Audience growth review, revenue tracking, campaign performance, identifying winners and losers
**Access level:** Read-only

### 8. Finance Dashboards / Portfolio Visibility
**Why:** Financial visibility is strategically relevant for capital allocation decisions.
**Access level:** Read-only by default. Never give autonomous money-movement rights to the AIgent.

### 9. Cloud Storage / Asset Library
**Why:** Central access to files, brand kits, and business docs improves routing and creative continuity.
**Access level:** Start read-only. Add limited write only where safe and useful.

### 10. Automation / Webhook Layer
**Why:** This is where leverage becomes real — but also where risk grows fast.
**Best use:** Moving approved outputs between systems, triggering task creation, routing alerts
**Access level:** Start very cautiously. Limited write with narrow scope. No broad autonomous actions until workflows are proven.
**Essential now:** No — later-stage leverage tool.

---

## Tool Ownership by Role

### The AIgent
Primarily uses: file access, notes/docs, task manager, web research, calendar, email visibility, analytics visibility, finance visibility, dashboards, reporting systems.

The AIgent is an operator, not a reckless actuator. Bias toward visibility, structure, and routing.

### Engineering Agent
Primarily uses: terminal, repo/code access, logs, technical dashboards, dev tools, testing tools, deployment environments, automation systems.

### Finance Agent
Primarily uses: finance dashboards, spreadsheets, forecasts, accounting views, budgeting models.

Read-heavy. No capital movement authority.

### Research Agent
Primarily uses: web research, searchable knowledge base, competitor/trend sources.

Read-only almost always.

---

## What Should Always Require Approval

Even with strong tooling, these categories should require the principal's approval before final action:
- Sending important external emails
- Publishing public-facing content
- Deploying changes to live business-critical systems
- Spending money or changing major budgets
- Deleting files or records
- Modifying contracts or legal docs
- Sending messages to top partners, investors, or sensitive contacts
- Triggering broad automations with external consequences
- Making irreversible system changes

The AIgent may prepare. The AIgent may draft. The AIgent may recommend. But the AIgent should not autonomously finalize these.

---

## What the AIgent Should Never Be Given

- Bank transfer authority
- Unrestricted email sending
- Unrestricted publishing authority
- Legal-signature authority
- Deletion rights across critical systems
- Production deployment without controls

Power without boundaries degrades trust.

---

## Recommended Rollout Order

### Phase 1 — Awareness and Continuity
Give the AIgent: file access, web research, notes/docs, task system, calendar visibility.
Goal: Understand context, maintain continuity, structure work.

### Phase 2 — Operational Visibility
Add: email visibility, analytics, finance visibility, cloud storage.
Goal: Improve situational awareness and decision support.

### Phase 3 — Controlled Action
Add: limited-write task management, limited-write document maintenance, narrow workflow automations.
Goal: Reduce manual coordination and increase leverage.

### Phase 4 — Advanced Orchestration
Add: approved automations, dashboard integrations, alerting systems, deeper cross-system routing.
Goal: Turn the AIgent into a true command layer without losing control.

---

## Tool Selection Standard

When recommending a specific plugin or integration, provide:
- Tool name and role it serves
- Why it is needed
- Access level required
- What risk it introduces
- Whether it is essential now or later
- Which agent should use it
- What approval rules should govern it

No vague tool wishlists. Every recommendation should be role-based and justified.

---

## Failure Conditions

The tool stack is failing if:
- Too many systems hold overlapping truth
- the AIgent spends more time managing tools than improving decisions
- Broad permissions are granted before clear need
- Automations create hidden risk
- Complexity rises faster than leverage
- Tools begin driving workflow instead of serving it

## Success Conditions

The tool stack is working if:
- the AIgent has enough visibility to maintain continuity
- Priorities are easier to manage
- Fewer things are forgotten
- Decisions are better informed
- The principal repeats themselves less
- The stack stays clean and understandable

The best stack is not the biggest stack. It is the cleanest stack that gives the right layer the right visibility and the right amount of power.
