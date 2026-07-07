# Creating Agents

The AIgent is one agent — the strategic layer. But real operational leverage comes from building **specialized agents** that handle execution in their domain. This guide walks through how to design, deploy, and coordinate them.

## When to Create an Agent

Only when ALL of these are true (from `system/09_subagent_manifest.md`):

1. **Specialization creates leverage** — A general agent handles this task poorly
2. **Recurring need** — You'll need this capability repeatedly
3. **Clear scope boundary** — You can define what it owns and what's off-limits
4. **Model routing benefit** — It can run on a cheaper model than the main session

If a task is just a variation of existing scope, give instructions to an existing agent — don't create a new one.

## Agent Anatomy

Every agent needs five things:

### 1. Identity Document

A markdown file that defines who the agent is. Lives in `vault/agents/`.

```markdown
---
title: Architect
tags:
  - agent
  - engineering
aliases:
  - CTO
  - Engineering Lead
---

# Architect

**Role:** Technical execution lead — code, infrastructure, deployments
**Model Tier:** Mid (sonnet)
**Status:** Active
**Interface:** Receives structured briefs from the AIgent. Returns completed work with verification.

## Scope
- All code: backend, frontend, infrastructure, CI/CD
- Technical architecture decisions within approved parameters
- Security patches and dependency updates
- Performance optimization

## Does NOT
- Make product decisions
- Communicate directly with external parties
- Deploy to production without approval (Level 2)
- Modify billing or infrastructure access (Level 3)

## Tools
- GitHub (read files, create branches, write files, open PRs)
- Database access (read-only by default, write with approval)
- Browser automation for testing
- Package managers and build tools

## Communication
- Receives: Delegation briefs from the AIgent
- Returns: Completed work + verification evidence
- Escalates: Blockers, scope questions, anything outside defined boundaries
```

### 2. Tools & MCP Servers

Each agent gets the tools it needs — nothing more. This follows the principle of least privilege.

| Agent Type | Typical Tools |
|-----------|--------------|
| Engineering | GitHub MCP, database MCP, Bash, file system |
| Research | Web search, web fetch, Perplexity MCP, file system |
| Creative | Image generation APIs, design tools, browser for reference |
| Finance | Spreadsheet tools, calculator, database (read-only) |
| QA | Browser automation (Playwright), database, API testing |
| Communications | Email MCP, Slack MCP, messaging APIs |

Configure tools in the agent's Claude Code settings or pass them via MCP configuration.

### 3. Model Tier

Match the model to the work:

| Agent Work | Model | Why |
|-----------|-------|-----|
| Reading, searching, fetching | Fast (haiku) | Only needs to retrieve and summarize |
| Writing code, drafting content | Mid (sonnet) | Needs to reason and produce |
| Architecture, complex judgment | Frontier (opus) | Needs deep reasoning |

**Most agents run on mid.** Fast is for pure data retrieval. Frontier is for the main aigent-OS session where strategic judgment lives.

### 4. Scope Boundaries

The authority matrix applies to agents too. Define explicitly:

- **What it can do without asking** — commits, branch creation, dependency updates
- **What it needs approval for** — production deployments, architecture changes, external API integrations
- **What it never touches** — billing, access control, other agents' scope

Write these in the agent's identity document. The AIgent references them when routing work.

### 5. Vault Profile

The agent gets a note in `vault/agents/` using the agent template. This is how the AIgent knows what the agent can do when deciding how to route work.

## Deployment Models

### Model A: Sub-Agent in the Same Session

The simplest approach. The AIgent spawns the agent using Claude Code's Agent tool within the same conversation.

```
the AIgent (opus) → spawns Agent (sonnet) with specific brief → gets result back
```

**Best for:** Quick, bounded tasks. Research. Drafting. Code review.
**Limitation:** Shares the same context window. Can't run truly independently.

### Model B: Separate Claude Code Terminal

The agent runs as its own Claude Code instance — separate machine, separate conversation, separate context.

```
Machine 1: the AIgent (your machine)
Machine 2: Architect (engineering machine)
```

Coordinate via a shared comms system (API, database, or message queue). Each agent has its own CLAUDE.md, its own hooks, and its own tool configuration.

**Best for:** Heavy execution work. Agents that need large context. Long-running tasks.
**Requirement:** A way to pass messages between agents (API endpoint, shared database, or message files in a shared vault).

### Model C: Scheduled / Triggered Agents

Agents that run on a schedule or in response to events, not on demand.

- **Cron agent:** Checks dashboards every 6 hours, posts summary
- **Webhook agent:** Triggers on GitHub PR, runs code review
- **Monitor agent:** Watches production logs, alerts on anomalies

**Best for:** Automation that doesn't need human initiation.

## Communication Patterns

### The AIgent → Agent (Delegation Brief)

Always use the structured brief from `system/05_delegation_protocol.md`. Include:
- Objective (one sentence)
- Context (what the agent needs to know)
- Deliverable (what "done" looks like)
- Constraints (scope, time, budget)
- Verification (how you'll check the work)

### Agent → The AIgent (Status Report)

Agents report back with:
- **Status:** Done / Blocked / Needs input
- **Deliverable:** The actual work product
- **Verification:** Proof it works (not just "I did it")
- **Surprises:** Anything unexpected found during execution
- **Next steps:** What should happen next (if applicable)

### Agent ↔ Agent (Never Direct)

Agents don't talk to each other. All coordination flows through the AIgent. This prevents:
- Conflicting instructions
- Scope overlap
- Work happening without the principal's awareness

If Agent A needs something from Agent B, Agent A tells the AIgent, and the AIgent routes it.

## Example: Standing Up a New Agent

Say you need a QA agent that tests your web app via browser automation.

**Step 1:** Create `vault/agents/QA Agent.md` with identity, scope, tools, and boundaries.

**Step 2:** Configure its tools — Playwright MCP for browser automation, database MCP for checking data.

**Step 3:** Define what it can verify autonomously (UI renders correctly, API returns expected data) vs. what needs human review (visual design quality, UX flow decisions).

**Step 4:** Write the first delegation brief: "Test the login flow on staging. Verify: page loads, form accepts input, authentication succeeds, dashboard renders. Report any failures with screenshots."

**Step 5:** Run it. Review the output. Adjust scope based on what you learn.

**Step 6:** Update the vault profile with what you learned about its capabilities and limitations.

## Anti-Patterns

- **Agent proliferation** — Don't create an agent for every task. Create them for recurring capability gaps.
- **Overlapping scope** — Two agents that own the same domain create confusion. One owner per domain.
- **No verification** — "Agent says it's done" is not verification. Check the work.
- **Frontier model for everything** — Most agents don't need your most expensive model. Route by task type.
- **Skipping the brief** — Unstructured delegation produces unstructured output. Every time.
