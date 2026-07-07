# 05 — Delegation Protocol

Every piece of work delegated to a sub-agent uses this structured brief format. No exceptions. Unstructured delegation produces unstructured output.

Never pass raw thoughts downstream. Every delegated task must be converted into a structured brief.

## The Delegation Brief

```
## Brief: [Task Name]

**From:** the AIgent
**To:** [Agent Name]
**Priority:** P0 (blocking) / P1 (important) / P2 (when possible)
**Date:** [YYYY-MM-DD]

### Objective
[One sentence: what needs to happen and why it matters]

### Context
[What the agent needs to know to do this well. Include:
- Current state of the relevant project/system
- What's been tried before
- Any constraints or requirements
- Links to relevant vault notes]

### Deliverable
[Exactly what "done" looks like. Be specific:
- File to create/modify
- Decision to make
- Report to produce
- Verification to perform]

### Constraints
- [Time: when this needs to be done]
- [Scope: what NOT to touch]
- [Dependencies: what must happen first]

### Acceptance Criteria
[How do we know the task is done well?]

### Risks / Edge Cases
[What could break, go wrong, drift, or be misunderstood?]

### Verification
[How the AIgent will verify the work is actually done correctly.
"Agent says it's done" is not verification.]
```

## Delegation Rules

1. **No delegation without a brief.** Verbal handoffs create ambiguity. Every task gets a written brief, even if it's short.

2. **Match the agent to the task.** Don't send strategy work to an engineering agent. Don't send code to a research agent. Route correctly.

3. **Match the model to the task.** Use the cheapest model that can handle the work. Fast model for reads, mid for writes, frontier for judgment calls.

4. **Define "done" before starting.** If you can't describe what the completed work looks like, the brief isn't ready.

5. **Verify, don't trust.** When a sub-agent reports completion, check the actual output. Read the code. Query the database. Look at the result. "It's done" is a claim, not a fact.

6. **Escalate early.** If a sub-agent is stuck, surface it to the principal. Don't let agents spin on problems they can't solve — that burns tokens and time.

7. **Do not delegate confusion.** Resolve as much ambiguity as possible first. Separate goals from assumptions. Separate constraints from preferences. Name the real bottleneck.

## Brief Quality Checklist

Before sending a brief, verify:
- [ ] Objective is one sentence and unambiguous
- [ ] Context includes everything the agent needs (no "you know what I mean")
- [ ] Deliverable is specific and verifiable
- [ ] Constraints are explicit
- [ ] Acceptance criteria defined
- [ ] Verification method is defined

## Handoff Templates

### The AIgent to Engineering Agent
- Objective and business context
- Priority level and urgency
- Constraints and non-negotiables
- Desired output and definition of done
- What has already been decided
- What is still open

### The AIgent to Principal (for approval)
- Decision summary
- Why it matters
- Recommendation
- Alternatives considered
- Risks
- Next move

### The AIgent to Specialist Agent
- Problem to solve and why it matters
- Scope boundary
- Output needed
- Deadline or cadence
- What should be escalated back to the AIgent
