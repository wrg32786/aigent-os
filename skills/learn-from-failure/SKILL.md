# /learn-from-failure — Convert failure to reusable artifact

When a failure occurs, classify it, check for repetition, and produce a durable artifact that prevents recurrence.

## Trigger

`/learn-from-failure` or `/learn-from-failure <failure description>`

Caddy auto-surfaces on: "same issue", "happened again", "recurring", "third time", "keeps happening"

## Flow

### 1. Identify failure
- If argument provided: use it
- If no argument: ask "What failed?"

### 2. Classify failure mode

| Mode | Description | Example |
|------|-------------|---------|
| `routing` | Task sent to wrong agent/model/tool | Opus used for a read-only task |
| `verification` | Output accepted without checking data flow | Video "looked fine" but spec was wrong |
| `tool` | Tool unavailable, broken API, wrong usage | Gmail MCP auth expired |
| `knowledge` | Agent lacked domain knowledge | Didn't know SDK v6 changed type strings |
| `authority` | Agent acted outside delegation zone | the AIgent made a Level 3 decision |

### 3. Check for repetition
Read `$AIGENT_VAULT/memory/FAILURE_MODES.md`. Search for Pattern lines matching the current failure's root cause.

- **0-1 prior occurrences:** Phase 1 — log and monitor
- **2+ occurrences:** Phase 2 — mandatory artifact. A log entry is not enough.
- **3+ occurrences:** The prior artifact failed. Diagnose why and fix or replace it.

### 4. Log to FAILURE_MODES.md
Append a new entry following the existing format:

```markdown
## {YYYY-MM-DD} — {short symptom name}

**Symptom:** {what went wrong, user-visible}
**Verified cause:** {exact mechanism}
**Fix:** {what was done}
**Layer:** {which system layer}
**Pattern:** {one-line category — this is the load-bearing piece for repetition detection}
```

### 5. Determine artifact type

| Failure mode | Artifact | Target |
|---|---|---|
| `routing` | Caddy trigger or hook | `.claude/hooks/` or `.claude/skill-index.json` |
| `verification` | Checklist item in doctrine | Relevant doctrine note |
| `tool` | SKILL_GAPS entry + skill spec | `memory/SKILL_GAPS.md` |
| `knowledge` | Vault note or memory candidate | `concepts/` or `memory/` |
| `authority` | Flag to the operator | `aigent_authority_matrix.md` |

### 6. Create artifact
- For routing: draft a Caddy enrollment entry with 3+ trigger phrases
- For verification: append a concrete, runnable check to the relevant doctrine
- For tool: log to SKILL_GAPS.md, suggest /skill-hunt if external capability needed
- For knowledge: write a memory candidate or vault note
- For authority: surface to the operator with recommendation

### 7. Output
```
Failure logged: {classification}
Pattern: {pattern line}
Repeated: {yes/no, count}
Artifact: {type} at {path}
```

## Boundary

Per [[Self-Learning Doctrine]]: a failure logged without an artifact is a false resolution. The ledger grows, the failure recurs, the system learns nothing.

## Bounded procedure experiment (fixture only)

A Finding is an observation, not a verified cause or permission to edit a
procedure. Keep the observed outcome separate from a proposed explanation.
The local #140 exercise is runnable with
`node --test daemons/tests/procedure-experiment.test.mjs`. Its ten tests cover
intake through rollback using a sanitized reconstruction of the #134 incident.
No installed skill is changed and no candidate is activated.

The exercise reuses `observeLedgerFinding` for intake and deduplication,
the `/dream` proposed candidate fields, and `validateMetaGate` for the operator
evidence check. It retains the proposal object's observation, hypothesis,
success predicate, falsifying result and disposition fields, and the existing
eval packet fields (`preregistration`, `packet_sha256`, `instrument_sha256`,
`terminal`, `results` with `id`, `class`, `status`, `detail`). The adapter under
`evals/procedure-experiment/` adds only the missing fixture boundaries: immutable
preregistration, exact delta hashes, independent deterministic verdict,
explicit fixture approval, unrelated-region hashes and a pre-recorded rollback.
The existing eval runner scores other capabilities; the skill-loop draft judge
uses a model and whole-draft promotion, so neither executes these boundaries.

One origin, three held-out variants and three healthy controls run against
both versions. Origin failure must become a pass; every candidate case must
pass within zero model tokens, 1000 ms evaluator time and 128 bytes growth.
The stopping rule is one paired pass without tuning or retries. Missing or
ambiguous evidence holds; altered frozen records refuse. An overfit delta,
instruction text and an exceeded budget produce recorded rejections. Model
notes and helpful/harmful votes cannot produce a verdict. Approval is separate
from the verdict and names the exact candidate and current base.

The first test run was red: 9 passed, 1 failed, exit 1. Row 10 reported
`AssertionError: Missing expected exception.` because an arbitrary hash
mismatch could support the incident. Pinning the admitted observation closed
that gap. Set `PROCEDURE_EXPERIMENT_REPORT=1` when running the same test to
refresh `evals/procedure-experiment/result.json`, including rejections and
refusal reasons. The fixture is removed after each test; the result packet
retains the hashes and measured outcomes.

This measures a finite interpreter of a reconstructed procedure, not natural
language compliance, live resume behavior or future recurrence. Evaluator
identity is a pinned deterministic instrument distinct from the proposal
author; it is not authenticated independent human review. Approval is an
explicit test record, not operator authorization for a real skill. Freeze
integrity is enforced within one sequential process, not across restarts or
hostile filesystem writers. Any real delta remains a human-review proposal.
ACE is design input only ([pinned reference](https://github.com/ace-agent/ace/tree/82709de050e1db6e6ef2f07bcb0393560b94992a));
no upstream code, prompts, dependencies or benchmark claims are imported.

## Related

- [[concepts/Self-Learning Doctrine]] — the doctrine this skill implements
- [[memory/FAILURE_MODES.md]] — the ledger
- [[concepts/Capability Expansion Doctrine]] — tool failures feed the expansion loop
- [[Self-Improving CLAUDE.md]] — the broader self-improvement cycle
