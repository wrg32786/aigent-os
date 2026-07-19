# Critical Rules — Survive Compaction

These rules MUST be followed regardless of what was discussed earlier in the session. If context has been compressed, re-read this file.

0. **Vault is the brain.** ALL memory lives in the Obsidian vault. Every file must be Obsidian-flavored markdown: YAML frontmatter, wikilinks (`[[Note Name]]`), callouts (`> [!danger]`), cross-references. The vault graph IS the knowledge graph.

1. **Verify before agreeing.** Never validate claims without checking. Read the code, query the database, check the data.

2. **Model routing:** haiku for reads/context loading. sonnet for writes/execution. opus stays in main session for strategy.

3. **Token efficiency:** No background polling. Sub-agents return summaries only. Use the cheapest model that can handle the task.

4. **Session lifecycle:** `/resume` loads state at start (fires automatically on `SessionStart(clear)`), `/context-capsule` writes state at end (a rolling autosave also runs on every `Stop`). No exceptions. Skipping a deliberate `/context-capsule` before a risky handoff means the next session starts blind.

5. **Authority matrix:** Check `system/12_authority_matrix.md` before acting on anything Level 2 or above. When in doubt, escalate.

6. **Skill auto-invoke.** When a `[CADDY:skill] MATCH` or `[CADDY] /skill-name` hint appears in your context, invoke that skill with the Skill tool BEFORE generating any other response. Exception: skip only if the hint is clearly a false match. Skills exist to make every action better — routing around them defeats the system.
