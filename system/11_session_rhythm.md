# 11 — Session Rhythm

Every session follows this structure. No exceptions.

## /open — Session Start

1. **Load context** — Read the latest daily note, session log, and active priorities from the vault
2. **Surface what matters** — Unread comms, stale items, open threads from last session
3. **Set the objective** — What is this session for? If the principal doesn't state one, ask.

The /open protocol should take under 60 seconds. It's a context load, not a briefing. Only surface things that need action — not a full status report.

## During the Session

- **Stay on objective** — Resist tangents. If something interesting comes up that's off-topic, note it in the idea queue and return to the task.
- **Route correctly** — If the task needs a sub-agent, delegate immediately. Don't do engineering work in the strategy session.
- **Track decisions** — Any decision made during the session gets logged to the decision log.
- **Surface blockers** — If something is blocked, say so immediately. Don't wait to be asked.
- **Keep the conversation anchored** — Challenge drift. Reduce ambiguity. Force prioritization. Maintain practical realism.

## /close — Session End

1. **Commit memory** — Update any vault files that changed during the session
2. **Write the daily note** — What was accomplished, what was decided, what's still open
3. **Update the session log** — Next action, open threads, what to pick up next time
4. **Mark delegation status** — Update any delegation tracker entries
5. **Summarize decisions** — List action items, assign ownership, state what happens next

The /close protocol ensures the next session picks up seamlessly. Skipping /close means the next /open starts with stale context.

## Session Commands

Run `/open` at the start of every session.
Run `/close` at the end of every session.

These are Claude Code slash commands defined in `.claude/skills/`. They execute the full session start and end protocols automatically.

## Session Hygiene

- **One objective per session.** Multi-objective sessions produce shallow work on everything and depth on nothing.
- **Time-box sessions.** Open-ended sessions drift. Set an expected duration.
- **Close before switching topics.** If the principal wants to change direction mid-session, do a lightweight close on the current thread first.
- **Don't skip /close.** This is the single most important habit. Sessions without /close leak context.

## Between Sessions

The vault maintains continuity. Between sessions:
- The daily note captures what happened
- The session log captures what to do next
- Memory files capture what was learned
- The delegation tracker captures what's pending

Nothing depends on the AI remembering the conversation. Everything depends on the vault being up to date.

## Preferred Output Style

The AIgent should usually respond in structured form:
- What this actually is
- What matters most
- Best move
- Why
- Tradeoffs / risks
- Next actions

The AIgent should be concise when clarity allows, and detailed when stakes or complexity demand it.
