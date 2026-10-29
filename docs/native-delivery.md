# Native delivery: the Room as the ledger, the engine as the transport

*fleet-delivery mod 0.4.0, 2026-10-29.*

## The problem it removes

Seat-to-seat mail in the fleet was a Room file (the record) delivered by typing it into the recipient's prompt box (the transport). Every stall seen on the live seats in October 2026 was a stall of that transport or of the claim state that guards it, never of the record itself:

| ledger state | what it meant |
|---|---|
| `deferred:composer-busy` | the recipient's prompt box held a draft |
| `deferred:supervisor-hold` | the supervisor froze the inbox for a refresh handshake |
| `deferred:refresh-hold` | the runner's cycle file was not idle |
| `submitting:unresolved` | a claim with no submit in flight; everything behind it waited for an operator's `/delivery-reconcile` |
| (DaVinci, 2026-10-29 16:36Z) | a message typed during the clear landed as the first prompt of the new session, ahead of the resume |

## The design

1. **Record unchanged.** `room_send` still writes the envelope file into `<roomRoot>/inbox/<seat>/`; the per-seat ledger (`<memoryRoot>/runtime/mod-delivery-ledger.<seat>.jsonl`) and the inbox/claimed/processed folders keep their meaning. Read receipts, replay and audit stay file-based.
2. **Transport: the engine's cross-session channel.** The sender's mod hooks `tool.call` for `mcp__agent-room__room_send`; after the Room server answers, it calls `$.session.send({ to, text })`. The engine queues it inside the recipient's session: a turn of its own when idle, delivered into the running turn otherwise. No composer and no idle requirement for those two cases; the clear window is the one case still to be measured (see Residue).
3. **Queue on arrival, settle on evidence.** The engine raises `session.receive` before it queues the delivery, so arrival is not reading. On arrival (seat's own model, not a subagent) the recipient's mod rebuilds the text from the Room file the tag names, compares body and tag, hands the model the rebuilt text, and records `deferred:native-queued`; nothing moves. A refresh cycle that is not idle, a supervisor hold, an unseeded ledger, a supervisor-owned seat or a file already in processed/ consume the copy (it can never become the first prompt after a clear, ahead of the resume, and never reads twice) and the file waits for the tick. Inside every tick, before anything is queued, the mod reads the transcript forward from the point each copy was handed over (a host-held pending set keeps the id and that index) for every handed file and every file still native-queued, whatever the status says now; only a user row carrying the tag records `delivered:native` and moves the file to processed/. A copy the engine dropped never confirms and the prompt box delivers the file 5 minutes after the end of the turn it was handed in, never while a turn runs (the turn is host state, so a hot reload keeps it; a turn older than the submit timeout counts as over). A control line, a seat the supervisor owns, a file already in processed/, an unseeded ledger, a hold (urgent mail excepted during a fresh capsule phase) and any failure after the match all consume the copy and leave the file to the tick. Already delivered is consumed; mid-submit is passed on with a note and that submit owns the ledger.
4. **Fallback: the prompt box.** A refused native send (no registered session of that name) leaves the file in the inbox; the tick delivers it as before, under all the existing holds. Senders without a session (supervisor lifecycle legs, job results, cron writers) always use the fallback.

## What was measured on a disposable seat (2026-10-29, supervisor topology, own Room dir)

| case | result |
|---|---|
| native message to an idle seat | taken as its own turn, answered within 5 s |
| native message during a running turn | read inside that turn (two messages batched into one user row) |
| native message after the capsule-done ack, before any clear | read as a turn in the live session; the probe's supervisor never reached the clear (its stop-token plumbing was not wired on the makeshift seat), so the across-the-clear case is NOT proven by this probe; by design the mod now consumes a native copy while the cycle is not idle, so that window is closed on the receiving side rather than measured |
| name spelled `Probe-Seat` for a session registered `probe-seat` | delivered (resolution ignores case) |
| a session sending to itself | refused by the engine: the receiver's mod cannot self-deliver, so the sender's mod sends |
| what `session.receive` carries (capture mod on a disposable session, 2026-10-29 21:5xZ) | the engine's envelope, origin `peer`: `<cross-session-message from="uds:\\\\.\\pipe\\LOCAL\\cc-msg-…" from-name="Recovery" from-mode="prompting">` + newline + the sender's text + newline + `</cross-session-message>`; the mod unwraps it before matching |
| courier alternative (`claude -p` calling SendMessage, as job-results does) | $0.008 to $0.017 and 3.5 to 5 s per message; not needed for seat mail, kept for job results |

## Rollout (fleet of four, staged like the cf08677 cutover)

1. Merge the PR; the mod is a user-scope plugin read from `C:\dev\aigent-os-wt-mods`: `git -C C:/dev/aigent-os-wt-mods checkout --detach <merge-commit>` then `claude plugin update fleet-delivery@aigent-os`; `claude plugin list` must read 0.4.0.
2. Each seat loads 0.4.0 at its own relaunch (park, Will closes the window, relaunch through the seat's shortcut). Order: Titus, Metis, DaVinci, Pheme in her newsletter-safe window. A seat on 0.3.0 keeps working with a seat on 0.4.0: a 0.4.0 sender's native copy to a 0.3.0 recipient is read as an ordinary peer message, and the 0.3.0 tick still delivers the Room file through the prompt box once (the message is seen twice on that pair until both relaunch; acceptable for the transition, and the `[room-file …]` tag makes the duplicate recognisable).
3. Receipt per seat on aigent-os-program #49: `claude plugin list` version, one labelled Room message each way with the sender's `native queued` log line, the recipient's `deferred:native-queued` then `delivered:native` (detail `transcript row`) ledger lines AND the transcript user row carrying the tag, and one message sent while the recipient is mid-turn. The `native queued` line alone is not delivery evidence.
4. Not in this change: the supervisor's inbox freeze and the runner's refresh hold stay as they are; they now govern only the fallback path. Repointing the four legacy-runtime hooks on the supervisor seats remains a separate follow-up.

## Residue, stated plainly

- A message that reaches the engine while a clear is executing: not measured. The probe's supervisor never issued its clear, so this change proves delivery to idle sessions, into running turns, and after a capsule ack, but not across the clear boundary itself. The first field evidence comes from the staged rollout: one message sent to a seat during its refresh cycle, read from the new session's transcript. Until then the fallback path's behaviour is the known one.
- The native text is the recipient's model's to read; the engine frames it as a peer message, never as the operator's words. The receiver does not trust any sender-asserted origin field; the guard is the body match against the Room file.
- The sender lowercases `to`; the engine ignores case when resolving a name, so `DaVinci` and `davinci` reach the same session.
