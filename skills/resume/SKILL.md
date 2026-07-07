# /resume — Resume from last capsule

Pick up paused or active work from the most recent capsule.

## Trigger

`/resume` or `/resume {capsule-id}`

## Flow

1. **Find capsule**:
   - If argument provided: read `memory/capsules/{argument}.md`
   - If no argument: read `memory/BODY_STATE.json` → `state.last_capsule`
   - If no capsule found: output "Nothing to resume." and stop

2. **Validate status** — only resume capsules with `status: active` or `status: paused`
   - `resumed` → "Already resumed in a prior session."
   - `resolved` → "This work was completed."
   - `abandoned` → "This work was abandoned. Reopen? [y/n]"

3. **Display capsule summary**:
   ```
   Resuming: {objective}
   Status: {status}
   Waiting on: {waiting_on}
   Next action: {next_valid_action}
   Success criteria:
     - {criterion 1}
     - {criterion 2}
   Open questions:
     - {question 1}
   Last verified: {last_verified_state}
   ```

4. **Verify state** — before proceeding, check `last_verified_state`:
   - If it names a file: verify the file exists and hasn't changed unexpectedly
   - If it names a deploy: check deploy status
   - If it names a branch: verify branch exists and HEAD matches expectation
   - Report any drift before resuming work

5. **Mark resumed** — Edit capsule frontmatter: `status: resumed`

6. **Execute** — paste `next_valid_action` as the work prompt and proceed

## Related

- `/pause` — create a paused capsule
- `/context-capsule` — the capsule system
- [[concepts/Capsule v2 Doctrine]] — design rationale
