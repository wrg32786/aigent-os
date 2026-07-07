# Kernel Changelog

The kernel — the 15 numbered system documents (`00_identity.md` through `14_decision_framework.md`) plus the extended specs in `system/` — is higher-stakes than skills, hooks, or vault content. Changes here ripple into every session for every user. They deserve their own audit trail separate from the repo-wide [CHANGELOG.md](../CHANGELOG.md).

This file logs every change to a numbered kernel document or extended spec. Repo infrastructure, skills, hooks, daemons, and vault examples go in the repo CHANGELOG.

## Format

```
## YYYY-MM-DD — short summary

**Files changed:**
- `system/NN_filename.md` — what changed and why

**Breaking changes:** none / list

**Migration required for existing v0.x users:** none / steps

**Sign-off:** principal initials (the principal of the canonical aigent-OS install)
```

## Why this exists

Most projects don't need a separate kernel changelog. aigent-OS does, for two reasons:

1. **The kernel is loaded into every session as a system prompt.** A change to `system/02_operating_standards.md` changes how every AI behaves on every install at the next session. That's a different blast radius than adding a new skill or fixing a typo.

2. **The legibility thesis demands it.** If the kernel evolves silently, a user upgrading from v0.1 to v0.2 has no way to understand why their AI is suddenly behaving differently. A kernel changelog says: here's what changed in the operating manual, here's why, here's whether you need to do anything.

## When NOT to log here

Log in the repo [CHANGELOG.md](../CHANGELOG.md), not here:
- New skills, hooks, daemons
- Vault example additions
- Documentation in `docs/`
- README/CONTRIBUTING/SECURITY edits
- Asset/banner changes
- Test fixtures

Log here only when an actual numbered system doc or extended spec content changes.

---

## Unreleased

(Pending changes for the next release land here.)

---

## v0.1.0 — initial release

**Files added:**
- `system/00_identity.md` through `system/14_decision_framework.md` — the 15-document kernel
- `system/finance_agent.md` — extended spec
- `system/aigent_delegation_map.md` — extended spec
- `system/aigent_memory_and_continuity.md` — extended spec
- `system/aigent_operating_system.md` — extended spec
- `system/aigent_tools_and_plugins.md` — extended spec

**Breaking changes:** n/a (initial release)

**Migration required:** n/a

**Sign-off:** WG
