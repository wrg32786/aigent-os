---
description: Write a capsule, then tell the user to run /clear so the next session resumes from it
---

Do a manual context refresh:

1. Run the `context-capsule` skill: write and validate a capsule.
2. If validation passed, reply with exactly two short lines: the capsule path, and "Run /clear now. The new session will name this capsule and continue from it."
3. If it did not validate, say what failed and do not suggest /clear.

You cannot type /clear yourself; only the user can. Do nothing after those lines.
