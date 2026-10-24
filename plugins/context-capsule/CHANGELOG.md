# Changelog

## 0.1.0 - unreleased

First cut of the standalone context-capsule plugin.

- `/capsule`, `/refresh`, `/resume`, `/autorefresh-setup`.
- `PreCompact` hook: side effect only (PreCompact output never reaches the model). With no valid capsule it leaves a marker; the next `SessionStart(compact)` turns it into a `/capsule` nudge and deletes it.
- `SessionStart` hook for `clear` and `compact`: small pointer to the newest valid capsule; marks it `resumed` on `clear`.
- Corrupt, incomplete, spent and stale (older than 14 days by default; `maxAgeDays` option) capsules are refused with a stated reason.
- Hooks defer silently when a full aigent-os install is detected (project or user-scope settings, or the install marker).
- Capsule format and selection logic ported from aigent-os; capsules are interchangeable with a full install.
- Zero npm dependencies, no network, writes only to the capsule directory.
