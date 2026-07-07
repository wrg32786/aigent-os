# /context-capsule — Capsule v2: Resumable Execution State

Structured state preservation when context pressure rises OR a task completes. Output is a resume-ready capsule with full execution state, not a vibes summary.

**v2 upgrade:** Capsules are now resumable execution state (12-Factor Agents pattern). Every capsule includes `waiting_on`, `resume_trigger`, `next_valid_action`, and `success_criteria`.

## Trigger

`/context-capsule` or automatic when Caddy detects context pressure / task completion.

## Capsule v2 Schema

Write capsule to `$AIGENT_VAULT/memory/capsules/{id}.md` with this frontmatter:

```yaml
---
id: {YYYY-MM-DD}-{context}-{sequence}
parent_capsule_id: {previous capsule id or null}
status: active          # active | paused | resumed | resolved | abandoned
waiting_on: null        # will | agent | tool | external | null
resume_trigger: open    # open | file_change | manual | webhook
objective: "{one-line objective}"
next_valid_action: "{what to do next when resumed}"
success_criteria:
  - "{criterion 1}"
  - "{criterion 2}"
open_questions:
  - "{unresolved question}"
files_touched:
  - "{path/to/file}"
skills_used:
  - "{skill-name}"
agents_used:
  - "{agent-name}"
last_verified_state: "{what was confirmed working}"
created_at: {ISO 8601}
resolved_at: null
tags: [capsule, {context tags}]
---
```

## Body Content

After frontmatter, write:

```markdown
# Capsule — {objective}

## What shipped
{bullet list of completed work}

## Mental model
{key decisions, constraints, architecture choices made}

## Open threads
{unresolved items, pending decisions, blocked work}

## Resume prompt
{paste-ready prompt that picks up exactly where we left off — include specific file paths, line numbers, what to verify first}
```

## BODY_STATE Update

After writing the capsule, update `memory/BODY_STATE.json` field `state.last_capsule`:

```json
{
  "id": "{capsule id}",
  "path": "memory/capsules/{capsule id}.md",
  "objective": "{objective}",
  "status": "{status}",
  "created_at": "{ISO 8601}",
  "resolved_at": null,
  "parent_capsule_id": "{parent or null}"
}
```

## Backward Compatibility

Existing capsules without v2 fields (waiting_on, resume_trigger, etc.) still work. /open reads whatever fields exist. New capsules MUST include all v2 fields.

## Related

- [[concepts/Capsule v2 Doctrine]] — why capsules evolved
- [[concepts/Somatic Layer]] — the broader body-state system
- [[concepts/Session Protocol]] — how /open offers capsule resume
- `/pause` — create a paused capsule mid-session
- `/resume` — resume from last capsule
