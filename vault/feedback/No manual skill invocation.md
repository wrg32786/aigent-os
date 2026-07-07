---
title: No manual skill invocation
tags: [feedback, operations, skills]
aliases: []
created: 2026-05-11
---

No skills should require manual invocation besides `/open` and `/close`. If a skill matters, wire it into the session lifecycle (open, close, or a daemon/hook trigger). Don't leave useful maintenance sitting around waiting for the operator to remember it exists.

**Why:** The operator shouldn't have to track internal housekeeping. If a skill only runs when manually invoked, it effectively doesn't exist.

**How to apply:** When building or importing a skill, always define its trigger — either a Caddy hook pattern, a step in `/open` or `/close`, or a daemon. If it can't be triggered automatically, question whether it's worth having.

## Caddy hook

Trigger: any proposal to "run /X manually" or "invoke /X when you want"
Surface: this note — push back, wire it into lifecycle instead.
