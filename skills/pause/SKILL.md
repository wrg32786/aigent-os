# /pause — Pause current work with resumable state

Create a Capsule v2 with `status: paused` capturing full execution state for later resume.

## Trigger

`/pause` or `/pause waiting on {blocker}`

## Flow

1. **Capture state** — gather from current session:
   - Objective (what we were working on)
   - Files touched (from tool call history)
   - Skills and agents used
   - Last verified state (what was confirmed working)
   - Open questions and blockers

2. **Determine waiting_on** — from argument or ask:
   - `will` — needs Will's decision or input
   - `agent` — waiting on a sub-agent to complete
   - `tool` — waiting on external tool/API/deploy
   - `external` — waiting on someone outside the system (a colleague, a client, etc.)

3. **Set resume_trigger**:
   - `will` → `manual` (Will decides when to resume)
   - `agent` → `open` (next /open checks agent status)
   - `tool` → `manual` (check tool status on resume)
   - `external` → `open` (next /open surfaces the wait)

4. **Write capsule** — use `/context-capsule` schema with `status: paused`

5. **Update BODY_STATE.json** — set `state.last_capsule` with paused capsule info

6. **Output**:
   ```
   Paused: {objective}
   Waiting on: {waiting_on}
   Resume trigger: {resume_trigger}
   Next action: {next_valid_action}
   Resume with /resume or next /open will offer it.
   ```

## Related

- `/resume` — pick up paused work
- `/context-capsule` — the underlying capsule system
- [[concepts/Capsule v2 Doctrine]] — design rationale
