# 11 — Session Rhythm

Every session follows this structure. No exceptions.

## `/resume` — Session Start

1. **Load** — select the valid capsule with the newest frontmatter `created_at` (or a named capsule, if one was requested), and pull its `waiting_on` and `next_valid_action`. There is no pointer to resolve.
2. **Re-ground** — re-read the session log and active priorities. Live memory wins over anything the capsule says.
3. **Act** — take the one next step from `waiting_on`/`next_valid_action`. Resumption is proven by the action taken, not by capsule text showing up in context.

This runs automatically: the full procedure fires on `SessionStart(clear)` via `daemons/resume-verb.mjs`, and a lighter warm reinject (showing the newest active capsule) runs on every other session start via `daemons/sessionstart-reinject.mjs`. It should read as fast and action-oriented — not a status briefing.

## During the Session

- **Stay on objective** — Resist tangents. If something interesting comes up that's off-topic, note it in the idea queue and return to the task.
- **Route correctly** — If the task needs a sub-agent, delegate immediately. Don't do engineering work in the strategy session.
- **Track decisions** — Any decision made during the session gets logged to the decision log.
- **Surface blockers** — If something is blocked, say so immediately. Don't wait to be asked.
- **Keep the conversation anchored** — Challenge drift. Reduce ambiguity. Force prioritization. Maintain practical realism.

## `/context-capsule` — Checkpoint or Close

1. **Reconcile** — re-read the session log, active priorities, and this session's git commits. Record what happened, not what was said. Budget: 2–4 reads, no more.
2. **Write** the capsule — `vault/memory/capsules/<YYYY-MM-DD>-<slug>.md`, with `id`, `objective`, `waiting_on`, and `next_valid_action` all non-empty, plus the reference-only body sections (`Done`, `Historical-Errors → Resolutions`, `Files-Read / Files-Modified`, etc.).
3. **Stop** — one line naming the capsule path, then silence. There's no separate stamping step: `daemons/capsule-verb.mjs` exports `validateCapsuleText()` as a content-gate check available for a self-check or a test, not a trusted writer that stamps a pointer or a digest.

A rolling, best-effort version of this already runs on every `Stop` event (`daemons/stop-capsule-writer.mjs`), so nothing is lost if a session just ends without a deliberate checkpoint. Invoke `/context-capsule` explicitly when a thread is genuinely wrapping, a handoff is happening, or you want a clean checkpoint before something risky — not as a ceremony owed at the end of every session.

## Session Commands

`/resume` and `/context-capsule` are the two lifecycle verbs — Claude Code slash commands defined under `.claude/skills/`. Both fire automatically at their hook points (see above), so invoking them by name is for the explicit cases: a named-capsule resume, a deliberate mid-session checkpoint, or a handoff.

`/open` and `/close` are **retired**. The skill files still exist for compatibility but are deprecated — never present them as live commands.

## Session Hygiene

- **One objective per session.** Multi-objective sessions produce shallow work on everything and depth on nothing.
- **Time-box sessions.** Open-ended sessions drift. Set an expected duration.
- **Checkpoint before switching topics.** If the principal wants to change direction mid-session, run `/context-capsule` on the current thread first so its `waiting_on` is real instead of a stale rolling snapshot.
- **The autosave already has you covered.** The every-`Stop` capsule write means nothing depends on remembering to bank state — it's best-effort autosave, never a gate. Explicit checkpoints exist to leave a *clean* `waiting_on` for a specific handoff, not to prevent loss.

## Between Sessions

The vault maintains continuity. Between sessions:
- The capsule's `waiting_on` and `next_valid_action` carry the concrete next step
- The session log and daily note capture the broader narrative of what happened
- Memory files capture what was learned
- The delegation tracker captures what's pending

Nothing depends on the AI remembering the conversation. Everything depends on the vault — and the latest capsule — being up to date.

## Preferred Output Style

The AIgent should usually respond in structured form:
- What this actually is
- What matters most
- Best move
- Why
- Tradeoffs / risks
- Next actions

The AIgent should be concise when clarity allows, and detailed when stakes or complexity demand it.
