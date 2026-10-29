# Native delivery: the Room as the ledger, the engine as the transport

*fleet-delivery mod 0.4.0, 2026-10-29.*

## The problem it removes

Seat-to-seat mail in the fleet was a Room file (the record) delivered by typing it into the recipient's prompt box (the transport). Every stall seen on the live seats in October 2026 was a transport stall, never a record stall:

| ledger state | what it meant |
|---|---|
| `deferred:composer-busy` | the recipient's prompt box held a draft |
| `deferred:supervisor-hold` | the supervisor froze the inbox for a refresh handshake |
| `deferred:refresh-hold` | the runner's cycle file was not idle |
| `submitting:unresolved` | a claim with no submit in flight; everything behind it waited for an operator's `/delivery-reconcile` |
| (DaVinci, 2026-10-29 16:36Z) | a message typed during the clear landed as the first prompt of the new session, ahead of the resume |

## The design

1. **Record unchanged.** `room_send` still writes the envelope file into `<roomRoot>/inbox/<seat>/`; the per-seat ledger (`<memoryRoot>/runtime/mod-delivery-ledger.<seat>.jsonl`) and the inbox/claimed/processed folders keep their meaning. Read receipts, replay and audit stay file-based.
2. **Transport: the engine's cross-session channel.** The sender's mod hooks `tool.call` for `mcp__agent-room__room_send`; after the Room server answers, it calls `$.session.send({ to, text })`. The engine queues it inside the recipient's session: a turn of its own when idle, delivered into the running turn otherwise. No composer, no idle requirement, no hold.
3. **Settlement on arrival.** The recipient's mod hooks `session.receive`; a delivery carrying `[room-file <seat>/<file>]` settles that Room file (inbox or claimed to processed; ledger `delivered:native`). A file the ledger already holds final is answered `consumed`. A file mid-submit through the prompt box is left to that submit.
4. **Fallback: the prompt box.** A refused native send (no registered session of that name) leaves the file in the inbox; the tick delivers it as before, under all the existing holds. Senders without a session (supervisor lifecycle legs, job results, cron writers) always use the fallback.

## What was measured on a disposable seat (2026-10-29, supervisor topology, own Room dir)

| case | result |
|---|---|
| native message to an idle seat | taken as its own turn, answered within 5 s |
| native message during a running turn | read inside that turn (two messages batched into one user row) |
| native message after the capsule-done ack, before any clear | read as a turn in the live session; the probe's supervisor never reached the clear (its stop-token plumbing was not wired on the makeshift seat), so the across-the-clear case is NOT proven by this probe |
| name spelled `Probe-Seat` for a session registered `probe-seat` | delivered (resolution ignores case) |
| a session sending to itself | refused by the engine: the receiver's mod cannot self-deliver, so the sender's mod sends |
| courier alternative (`claude -p` calling SendMessage, as job-results does) | $0.008 to $0.017 and 3.5 to 5 s per message; not needed for seat mail, kept for job results |

## Rollout (fleet of four, staged like the cf08677 cutover)

1. Merge the PR; the mod is a user-scope plugin read from `C:\dev\aigent-os-wt-mods`: `git -C C:/dev/aigent-os-wt-mods checkout --detach <merge-commit>` then `claude plugin update fleet-delivery@aigent-os`; `claude plugin list` must read 0.4.0.
2. Each seat loads 0.4.0 at its own relaunch (park, Will closes the window, relaunch through the seat's shortcut). Order: Titus, Metis, DaVinci, Pheme in her newsletter-safe window. A seat on 0.3.0 keeps working with a seat on 0.4.0: a 0.4.0 sender's native copy to a 0.3.0 recipient is read as an ordinary peer message, and the 0.3.0 tick still delivers the Room file through the prompt box once (the message is seen twice on that pair until both relaunch; acceptable for the transition, and the `[room-file …]` tag makes the duplicate recognisable).
3. Receipt per seat on aigent-os-program #49: `claude plugin list` version, one labelled Room message each way with its `native sent` log line on the sender and `delivered:native` in the recipient's ledger, and one message sent while the recipient is mid-turn.
4. Not in this change: the supervisor's inbox freeze and the runner's refresh hold stay as they are; they now govern only the fallback path. Repointing the four legacy-runtime hooks on the supervisor seats remains a separate follow-up.

## Residue, stated plainly

- A message that reaches the engine while a clear is executing: not measured. The probe's supervisor never issued its clear, so this change proves delivery to idle sessions, into running turns, and after a capsule ack, but not across the clear boundary itself. The first field evidence comes from the staged rollout: one message sent to a seat during its refresh cycle, read from the new session's transcript. Until then the fallback path's behaviour is the known one.
- The native text is the recipient's model's to read; the mod never puts it in the operator's words (the engine frames it as a peer message, `origin.plugin` naming fleet-delivery).
