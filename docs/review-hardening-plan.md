# Repository Review and Hardening Plan

This document preserves the findings from the July 2026 repository review and distinguishes changes implemented by the hardening PR from architectural follow-ups that should land separately.

## Implemented in the hardening PR

- Correct option parsing for `--no-deps`, `--target`, and `--dry-run` in any supported order.
- Functional in-place activation when `bash install.sh` is run from the downloaded checkout.
- Idempotent managed blocks for `CLAUDE.md` and `.gitignore`.
- Persistent backups and a safe fallback for invalid existing settings.
- Copy coverage for root `memory/` and `evals/`.
- Machine-readable `.aigent/state.json` first-run state.
- First-run and normal-session skills that no longer depend on placeholder prose.
- Operational session paths standardized on `vault/memory/` and framework indexes explicitly separated under root `memory/`.
- Runtime vault auto-resolution that prefers the real operational vault over root framework indexes.
- Privacy-safe activity capture that omits raw shell commands, MCP queries, content, and arbitrary fallback input.
- Prompt-injection scanning compatible with both `tool_result` and legacy `tool_response` payloads.
- End-of-session logging moved from `Stop` to `SessionEnd` in the settings template.
- Public Caddy defaults stripped of maintainer-specific cost incidents and optional plugin assumptions.
- Caddy gap flags keyed by session and stored under `.aigent/cache/` rather than falling back to `/tmp`.
- Installer, hook-redaction, and runtime-path regression tests in CI.
- Installation and security documentation rewritten to match actual behavior.

## Follow-up 1: plugin distribution

Package aigent-OS as a Claude Code plugin so hooks, skills, agents, and portable paths can be installed without copying a large framework block into every project. Keep vault initialization separate from plugin installation.

Acceptance criteria:

- Hooks use plugin-relative paths.
- User settings and plugin hooks coexist without custom deep-merge code.
- Uninstall removes product code without deleting operator memory.
- Upgrade behavior is versioned and tested.

## Follow-up 2: state schema migration

The hardening PR makes the current two-area layout explicit:

- `vault/memory/` is operator-owned operational memory.
- Root `memory/` is framework-owned skill and capability indexing.

A later schema migration should rename root `memory/` to a clearly internal location such as `.aigent/indexes/` and provide an idempotent migration tool.

Acceptance criteria:

- One generated path manifest defines every canonical location.
- No runtime component guesses a path from prose or current working directory.
- Migration backs up, validates, and reports conflicts rather than choosing a copy silently.
- CI rejects references to retired paths.

## Follow-up 3: Caddy router engine and evaluation corpus

Move prompt routing from a mixed Bash/Python script into a small testable engine with data-driven rules and structured output.

Measure:

- Suggestion precision and recall on a checked-in prompt corpus.
- False-positive rate.
- No-match rate.
- Suggestion-to-invocation rate.
- Per-rule latency.

Optional integrations and personal model policies should remain disabled unless enabled in local configuration.

## Follow-up 4: semantic-index correctness

Improve incremental indexing before optimizing speed:

- Use per-file content hashes or stored mtimes rather than one global update timestamp.
- Remove deleted and renamed notes from the index.
- Write indexes atomically.
- Add file locking and an index schema version.
- Rebuild when the embedding model or vector dimension changes.
- Add tests for deletion, rename, corruption, empty notes, and YAML edge cases.
- Store generated indexes under `.aigent/cache/` rather than the human knowledge graph.

## Follow-up 5: release integrity

Add:

- Signed tags or Sigstore attestations.
- SHA-256 checksums for release archives.
- An SBOM.
- Dependency review and secret scanning.
- A public-content lint that prevents personal names, internal channels, absolute home paths, private domains, and files marked `private: true` from entering release artifacts.

## Follow-up 6: evidence-backed product claims

Separate required, optional, beta, and experimental layers in the README. Quantitative claims such as cost reduction, routing accuracy, calibration improvement, and false-positive rates need a linked benchmark and methodology.

A useful demonstration should cover:

1. Fresh installation.
2. First-run setup.
3. A real work artifact.
4. `/close`.
5. A new session.
6. `/open` recovering the exact thread.

The product is strongest when the executable behavior carries the argument and the prose merely explains it.
