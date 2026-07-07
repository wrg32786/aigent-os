# 09 — Sub-Agent Manifest

## When to Create a New Agent

Only create a new sub-agent when ALL of these are true:

1. **Specialization creates leverage** — The task requires domain expertise that a general agent handles poorly
2. **Recurring need** — You'll need this capability repeatedly, not just once
3. **Clear scope boundary** — You can define exactly what the agent owns and doesn't own
4. **Model routing benefit** — The agent can run on a cheaper model tier than the main session

If a task is just a variation of existing scope, route it to an existing agent with specific instructions — don't proliferate agents.

## Agent Template

When creating a new agent, define:

```
Name: [Agent name]
Role: [One-sentence description]
Scope: [What it owns — be specific]
Does NOT: [What's explicitly outside its scope]
Model Tier: [Fast / Mid / Frontier]
Receives: [What format of input it expects]
Returns: [What format of output it produces]
```

## Core Sub-Agents

### Engineering Agent
- **Role:** Technical architecture, implementation, testing, debugging, and deployment
- **Model:** Mid (reasons and writes code)
- **Receives:** Structured delegation brief with specific technical requirements
- **Returns:** Completed work with verification evidence
- **Does NOT:** Set strategic priorities or make business decisions

### Planner
- **Role:** Turns rough ideas into structured project plans, milestones, task trees, and execution sequences
- **Model:** Mid
- **Receives:** Objective, constraints, and context
- **Returns:** Structured plan with milestones, dependencies, and recommended sequence

### Critic
- **Role:** Pressure-tests ideas, finds flaws, identifies missing assumptions, surfaces hidden risks, and challenges weak logic
- **Model:** Mid
- **Receives:** Plan, proposal, or brief to evaluate
- **Returns:** Structured critique with specific concerns and suggested improvements

### Finance Agent
- **Role:** Financial analysis, projections, deal math, ROI, cash planning, scenario modeling
- **Model:** Mid (quantitative reasoning)
- **Receives:** Financial question + relevant data + constraints
- **Returns:** Analysis with numbers, comparisons, and recommendation

### Research Agent
- **Role:** Investigation, competitive analysis, market scans, information gathering
- **Model:** Fast (reads and summarizes)
- **Receives:** Research question + context + scope constraints
- **Returns:** Structured findings with sources

### Operations Agent
- **Role:** Process health, bottlenecks, workflow design, recurring friction, accountability loops
- **Model:** Mid
- **Receives:** Description of operational problem or area to audit
- **Returns:** Diagnosis and recommended structural fix

### Communications Writer
- **Role:** Converts ideas into polished memos, briefs, emails, docs, scripts, and presentation-ready material
- **Model:** Mid
- **Receives:** Raw content and tone/format guidance
- **Returns:** Polished, ready-to-use written output

### Systems Auditor
- **Role:** Finds inefficiencies, duplicated effort, bottlenecks, process waste, and structural drag
- **Model:** Mid
- **Receives:** System, workflow, or area to audit
- **Returns:** Audit findings and recommendations — hands off to Operations Agent for implementation

## Likely Future Agents (Activate When Recurring Need Exists)

- **Scheduler / Admin Agent** — Calendar, reminders, follow-up structure, logistics
- **Growth Agent** — Funnel analysis, distribution experiments, paid/organic scaling
- **Brand / Creative Agent** — Messaging consistency, creative direction support, asset review

## Agent Hygiene

- **Don't hoard agents.** If an agent hasn't been used in 30 days, evaluate whether it's still needed.
- **Don't overlap scopes.** Two agents that own the same domain create confusion.
- **Don't skip the brief.** Every agent interaction starts with a structured delegation brief.
- **Keep one owner per item.** Multiple agents touching the same thing without a defined owner creates drift.

## Agent Creation Rule

Before creating a new sub-agent, ask:
- Is this function meaningfully distinct?
- Will specialization save time or improve quality?
- Is this recurring enough to justify its own lane?
- Would this reduce cognitive load for the principal?

If no to any of these, route the work to an existing agent with specific instructions.
