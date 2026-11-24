---
name: context-hygiene
agent: none
description: "Archive and trim ACTIVE_PRIORITIES and dated SESSION_LOG entries. Use when cleaning active priorities, trimming session logs, or running context hygiene."
allowed-tools: Read, Write, Bash
user-invocable: true
status: PRODUCTION - bounded archive writer
triggers:
  - context hygiene
  - trim session log
  - archive old session entries
  - clean active priorities
---

# /context-hygiene

This is the sole bounded compaction exception to the Session Log chronicle. It
runs only when invoked, never while the framework is being installed or tested
against a real vault.

## Precondition

1. Read `vault/memory/SESSION_LOG.md` and
   `vault/memory/ACTIVE_PRIORITIES.md`.
2. Hash both exact byte streams with SHA-256.
3. Run:

```text
node daemons/nightly-context-hygiene.mjs --root <aigent-root>
```

Green means no edit is needed. Red permits only the bounded archive below.
Unreadable or unfamiliar content is a failure, not permission to rewrite.

## Session Log archive

Live entries appear newest first by date. A capsule entry is one line in the
form `- YYYY-MM-DD capsule-id: summary`. The date must be a real calendar
date. The capsule id and its optional preceding short name are each one token
without whitespace. The summary must have text on the same line.
Capsule lines go above the dated blocks, and a dated line inside a block is part of that block.
The checker treats frontmatter as ordinary text, so keep lines starting with a dash and a date or with `##` and a date out of it, and keep fence markers balanced.

A dated H2 block starts with `## YYYY-MM-DD - title` and contains one
nonempty occurrence of each bold field listed below.

- `Objective`
- `Completed`
- `Decisions`
- `Open threads`
- `Next action`

Archival rules:

- Keep the newest five entries across both formats.
- Move older entries as whole lines or whole blocks to
  `vault/memory/SESSION_LOG_ARCHIVE_<YYYY-MM-DD>.md`.
- Preserve source text and order.
- Preserve frontmatter, title, schema guidance, and archive links.
- Dedupe one-line entries by exact line and blocks by exact dated heading plus block hash.
- Refuse a block whose boundary cannot be determined without judgment.

## Active Priorities archive

The mechanically checkable live shape contains:

- exactly one `## Operating Mode: <mode>` heading;
- one to five live bullet priorities under `## Tier 1`, `## Tier 2`, or
  `## Tier 3` headings;
- no placeholder priority;
- one valid `Last reviewed: YYYY-MM-DD` line; and
- no embedded `## Archived` section.

Move only content explicitly marked stale, superseded, or archived to
`vault/memory/ACTIVE_PRIORITIES_ARCHIVE_<YYYY-MM-DD>.md`. If removal requires a
human decision, preserve it and report the gate.

## Compare-and-swap

Immediately before each write, hash the live source again. If either hash
differs from the precondition hash, abort with `CONTEXT_HYGIENE_RACE`. Archive
must be durable before the source is trimmed.

After writing, re-run the checker. Only its literal
`CONTEXT_HYGIENE PASS` receipt may record the checkpoint green. Return archive
paths and before/after hashes in bounded detail. Never touch another memory
file.
