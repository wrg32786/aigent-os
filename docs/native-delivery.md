# Native pointer: the Room as the record, the engine as the doorbell

*fleet-delivery mod 0.4.0, 2026-10-29.*

## The problem it removes

Seat-to-seat mail in the fleet was a Room file (the record) delivered by typing it into the recipient's prompt box (the transport). Every stall seen on the live seats in October 2026 was a stall of that transport or of the claim state that guards it, never of the record:

| ledger state | what it meant |
|---|---|
| `deferred:composer-busy` | the recipient's prompt box held a draft |
| `deferred:supervisor-hold` | the supervisor froze the inbox for a refresh handshake |
| `deferred:refresh-hold` | the runner's cycle file was not idle |
| `submitting:unresolved` | a claim with no submit in flight; everything behind it waited for an operator's `/delivery-reconcile` |
| (DaVinci, 2026-10-29 16:36Z) | a message typed during the clear landed as the first prompt of the new session, ahead of the resume |

## The design, after six review rounds

The first six rounds of review were spent on a design where the mod carried the body natively, matched it against the Room file, timed a confirmation window and read the transcript to decide "delivered". Each round opened a new seam in the same three places (the match, the clock, the confirmation). The shape that ships has none of them:

1. **Record unchanged.** `room_send` writes the envelope file into `<roomRoot>/inbox/<seat>/`; the per-seat ledger and the inbox/claimed/processed folders keep their meaning; read receipts, replay and audit stay file-based.
2. **A pointer, not the body.** The sender's mod hooks `tool.call` for `mcp__agent-room__room_send`; after the Room server answers, it sends `Room mail for <seat> from <sender>: <file>` plus one line telling the model to call `room_drain`. The engine queues it inside the recipient: a turn of its own when idle, read inside the running turn otherwise. Nothing to match, nothing to forge: a forged pointer drains real mail, harmlessly.
3. **The Room's own consumer reads.** The recipient's model calls `room_drain`, which returns the unread inbox and moves each file to processed/ as read. The mod writes nothing for a natively read file; to its tick a drained file is absent, a case it already handles. One body read either way: a file lies in exactly one of inbox/ (`room_drain`'s) and claimed/ (the tick's).
4. **Two fences.** A seat is announced to only while its own mod publishes a fresh marker in the shared Room (`state/native/<seat>.json`: mod-owned, version 0.4.0 or later, under 15 min old), so a supervisor-owned seat, a seat on an older mod or a parked seat gets no pointer and its tick or supervisor delivers the file. And the recipient re-checks the holds at the moment the pointer becomes a prompt, not at arrival, whoever owns the seat by then (an owner flip leaves the marker fresh for up to 15 min; the marker is retired when the mod loses the seat and when the session ends): while its refresh cycle is not idle or its supervisor holds the seat, the pointer is dropped and the file waits. The fence fails closed: any peer prompt naming Room mail or `room_drain`, and any prompt whose hold check cannot be read, is dropped under a hold. So a pointer can never become the first prompt of a post-clear session ahead of the resume, even when the clear started after the pointer was queued.
5. **Fallback: the prompt box.** A refused pointer (no registered session of that name), a consumed one, or one the model ignored leaves the file to the tick, which delivers it as before under all existing holds. Senders without a session (supervisor lifecycle legs, job results, cron writers) always use the fallback.

## What was measured on a disposable seat (2026-10-29, supervisor topology, own Room dir)

| case | result |
|---|---|
| native message to an idle seat | taken as its own turn, answered within 5 s |
| native message during a running turn | read inside that turn (two messages batched into one user row) |
| native message after the capsule-done ack, before any clear | read as a turn in the live session; the probe's supervisor never reached the clear, so the across-the-clear case is not proven by this probe; by design the receiver consumes a pointer while the cycle is not idle |
| name spelled `Probe-Seat` for a session registered `probe-seat` | delivered (resolution ignores case) |
| a session sending to itself | refused by the engine: the sender's mod announces |
| what `session.receive` carries (capture mod on a disposable session) | the engine's envelope, origin `peer`: `<cross-session-message from="uds:…" from-name="Recovery" from-mode="prompting">` + newline + the sender's text + newline + `</cross-session-message>`; the receiver unwraps it |
| courier alternative (`claude -p` calling SendMessage, as job-results does) | $0.008 to $0.017 and 3.5 to 5 s per message; not needed for seat mail |

## Rollout (fleet of four, staged like the cf08677 cutover)

1. Merge; the mod is a user-scope plugin read from `C:\dev\aigent-os-wt-mods`: `git -C C:/dev/aigent-os-wt-mods checkout --detach <merge-commit>` then `claude plugin update fleet-delivery@aigent-os`; `claude plugin list` must read 0.4.0.
2. Each seat loads 0.4.0 at its own relaunch (park, Will closes the window, relaunch through the seat's shortcut). Order: Titus, Metis, DaVinci, Pheme in her newsletter-safe window. A seat on 0.3.0 and a seat on 0.4.0 interoperate: a 0.3.0 recipient publishes no marker, so it is never announced to; its tick delivers the file as before.
3. Receipt per seat on aigent-os-program #49: `claude plugin list` version, one labelled Room message each way with the sender's `pointer queued` log line, the recipient's transcript rows showing the pointer and its `room_drain` call returning the file, and one message sent while the recipient is mid-turn. The `pointer queued` line alone is not delivery evidence.
4. Not in this change: the supervisor's inbox freeze and the runner's refresh hold stay as they are; they govern the fallback path. Repointing the legacy-runtime hooks on the supervisor seats remains a separate follow-up.

## Residue, stated plainly

- The model must act on the pointer. A seat that ignores it is served by the tick as before; a seat that drains it has read the mail once. The receipt shows which happened.
- A pointer that reaches the engine while a clear is executing: not measured. The hold is re-checked when the pointer becomes a prompt, so a clear that began after the queueing still drops it; the rollout measures the case on the first seat.
- `broadcast` is never announced (a documented limitation); its recipients read it through their ticks as before.
