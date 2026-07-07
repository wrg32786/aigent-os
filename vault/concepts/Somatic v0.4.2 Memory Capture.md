---
title: Somatic v0.4.2 Memory Capture
tags: [doctrine, architecture, somatic, banked, queued]
aliases: ["v0.4.2", "memory capture", "auto-capture"]
created: 2026-05-03
status: banked
---

# Somatic v0.4.2 — Memory Capture

> [!warning] BANKED, NOT DISPATCHED. Gate: 1-2 real /close + /open cycles of v0.4.1 must run clean before this ships. The v0.4.1 same-session test surfaced a real Caddy bug (Git-Bash path translation) — that's exactly why this gate exists.

The input organ. Closes the somatic loop.

After v0.4.1: The AIgent has body-check (sense), /open + /close auto-integrations (rhythm), /digest (curate), MEMORY_CANDIDATES.md (staging surface). What's missing: **automatic capture of memory candidates from trigger phrases.** Caddy fires a hint when Will says "remember that X" / "from now on, X" / "new rule: X", but the candidate itself never gets staged. The AIgent has to manually append, and the AIgent forgets. /digest at /close runs against an empty MEMORY_CANDIDATES, the loop never closes, the discipline rots.

v0.4.2 wires capture so the input pipe works.

## Brief (one-line for Lyra dispatch)

> Extend Caddy to append a `status: staged` candidate row to MEMORY_CANDIDATES.md when high-confidence memory-authoring phrases fire. Append-only, principal-curates-at-digest, hard cap of 50 staged rows.

## Scope (4 changes)

### 1. Capture trigger phrases (high-confidence only)

Same regex patterns Caddy already uses for the [CADDY:memory] DIGEST hint, but narrowed to the highest-confidence subset:

| Pattern | Captured `type` | Captured `confidence` |
|---|---|---|
| `remember that X` / `remember to X` | preference | high |
| `from now on,? X` | doctrine | high |
| `new rule:? X` / `rule:? X` | doctrine | high |
| `we (decided\|agreed) X` | decision | medium |
| `going forward,? X` | doctrine | high |

**Excluded** (matches Caddy [CADDY:memory] hint but does NOT auto-capture): `/digest`, `review candidates`, `stage memory`, `promote candidate` — these are explicit invocations, not memory-authoring phrases.

### 2. Append to MEMORY_CANDIDATES.md

When a capture trigger fires, append one row to the `## Candidates` section of `memory/MEMORY_CANDIDATES.md`:

```markdown
| 2026-05-03 | "from now on, never push direct to main" | doctrine | high | concepts/Standing Rules - Engineering.md | staged | null | Auto-captured from prompt |
```

Schema follows existing MEMORY_CANDIDATES.md schema (date, source_phrase, type, confidence, suggested_destination, status, digested_on, note).

`source_phrase`: the exact captured phrase (max 200 chars, truncate-end-with-ellipsis if longer).
`suggested_destination`: rule-based default by type (`doctrine` → `concepts/Standing Rules - <area>.md`; `preference` → `feedback/<phrase-stem>.md`; `decision` → `memory/DECISION_LOG.md`).
`note`: always `Auto-captured from prompt` for v0.4.2 captures (distinguishable from manually-staged candidates).

### 3. Hard cap + dedupe

Before appending:
- **Hard cap:** if `staged` row count >= 50, skip the append silently and emit a one-time `[CADDY:memory] CAP — MEMORY_CANDIDATES backlog at 50, /digest before more candidates auto-stage` hint. Prevents runaway when the principal is in heavy memory-authoring mode (e.g., a big design session).
- **Dedupe window:** if the same `source_phrase` (case-insensitive, normalized whitespace) was captured within the last 24 hours and is still `staged`, skip the new capture. Prevents accidental triple-fires when Will rephrases the same rule three ways in one session.

### 4. Capture script wiring

Implementation:
- New script `daemons/memory-capture.sh` that takes the prompt text via stdin, applies the regex patterns from #1, and appends rows per #2.
- Called from `daemons/caddy.sh` AFTER the existing `[CADDY:memory] DIGEST` hint emits — sequential, same hook, same UserPromptSubmit invocation. Failure of the capture script must NEVER block Caddy hint output (best-effort write).
- Path translation handles Git-Bash → Windows the same way the v0.4.1 caddy.sh fix does. Reuse the helper.

**Doubled-write discipline:** patches go to BOTH `daemons/caddy.sh` (local + public aigent-OS mirror) AND `daemons/memory-capture.sh` (local + public mirror). Same lesson banked from v0.4.1.

## What v0.4.2 explicitly does NOT add

- **No auto-promotion.** Captured candidates are `status: staged`. /digest still surfaces them with promote/skip/supersede. Principal decides. Same rule as v0.4.1.
- **No ML / LLM phrase classification.** Regex patterns only. If Caddy can't catch it with a regex, it's not a high-confidence capture.
- **No retroactive scan.** v0.4.2 captures forward only. We don't grep daily notes for missed captures.
- **No editing existing candidates.** Append-only. Mutation lives at /digest.
- **No agent-fitness instrumentation.** Still v0.5 territory, still gated on real failure volume.

## Acceptance criteria

v0.4.2 is done when:

1. The 5 trigger phrase patterns capture verbatim into MEMORY_CANDIDATES.md
2. Excluded phrases (/digest, review candidates) do NOT auto-capture
3. Hard cap at 50 staged rows is enforced; cap-hit hint emits
4. 24h dedupe prevents same-phrase double-stage
5. Capture script failure does not block Caddy hint output
6. Path translation works in Git-Bash on Windows
7. `/digest` after a v0.4.2 capture session surfaces real candidates (the loop closes)
8. Mirrored to public aigent-OS for both `caddy.sh` patch and new `memory-capture.sh`

## Test plan

Same shape as v0.4.1 — exercise every piece in-session before declaring shipped:

- **Synthetic captures** via shell: `echo "from now on, always X" | bash daemons/memory-capture.sh` → row appears in MEMORY_CANDIDATES.md.
- **Excluded phrase test:** `echo "/digest" | bash ...` → no row appended.
- **Cap test:** stage 50 dummy rows, verify next capture is skipped + cap hint emits.
- **Dedupe test:** capture same phrase twice in one minute → only one row.
- **Path test:** verify on Git-Bash + Windows native Python.
- **Integration test:** real /close after 1-2 captured candidates → /digest surfaces them with promote/skip/supersede.

## Cross-links

- [[concepts/Somatic Layer]] — base doctrine
- [[concepts/Somatic v0.4.1 Wiring]] — predecessor (rhythm wiring)
- [[system/15_somatic_layer.md]] — canonical doctrine
- [[memory/MEMORY_CANDIDATES.md]] — staging surface
- [[memory/FAILED_EXPERIMENTS.md]] — Git-Bash path translation lesson
- [[concepts/Memory Decay Doctrine]] — why staged-with-curation beats auto-promote

## Sequencing

| Trigger | Action |
|---|---|
| Now (2026-05-03) | Spec banked. Wait for v0.4.1 real-world cycles. |
| After 1-2 clean v0.4.1 /close + /open cycles | Verify Step 0.5 + Step 2.5 fire as designed; verify capsule lifecycle transitions in real use. |
| If green | Dispatch Lyra for v0.4.2 build. Doubled-write discipline applies. |
| If v0.4.1 reveals new bugs | v0.4.2 absorbs the fixes; this spec gets re-banked with bug list. |
