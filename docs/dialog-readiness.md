# Dialog readiness

The managed runner (`daemons/pty-runner.mjs`) is the sole writer to a Claude Code
child's PTY. It writes automatically, without an operator keystroke behind it, in
a small number of places. This document is about one hazard those writes share:
**a permission dialog on screen turns an automatic keystroke into an answer.**

Issue #104.

## The defect

`_writeCapsuleRequest`'s only write gate was `composer.knownEmpty`. The input
ownership tracker models the composer's **text line** -- what the operator may
have typed and not submitted. It knows nothing about a modal dialog.

With a permission dialog open and nothing typed, `knownEmpty` is `true`. So the
runner wrote `/context-capsule` and, 400 ms later, a `CONTROL_ENTER`.

A bare Enter at that dialog selects option 1, **Yes**:

```
Do you want to proceed?
❯ 1. Yes
  2. Yes, and switch to accept edits (auto-approve file edits and common
     file commands) for this session
  3. No
Esc to cancel · Tab to amend
```

Option 2 is one row down. An Enter that landed there would disable prompting for
the rest of the session.

## The signal

While the host is waiting to run a tool -- which includes the entire time a
permission dialog is on screen -- the bound transcript holds a `tool_use` block
with **no matching `tool_result`**.

Measured on binary 2.1.309, capture `2026-10-23T16:09Z`:

| time | event |
|---|---|
| 16:09:55.083Z | `tool_use` written, id `toolu_016Dhtgz…`, name `Read` |
| 16:09:55.993Z | permission dialog on screen |
| 16:09:57.195Z | ESC sent |
| 16:09:57.250Z | `tool_result` for that id, `is_error: true`, *"The user doesn't want to proceed with this tool use…"* |

The pairing completes whichever way the dialog is answered -- approval,
cancellation, or error. **A post-hoc read of a finished transcript therefore
shows zero unanswered ids.** The signal exists only while it matters, which is
why it is read live at each write boundary rather than reconstructed afterwards.

### What is deliberately not used

The transcript records `"permissionMode":"default"` even when the child was
launched with `--permission-mode manual` (verified in the same capture). The
transcript's mode vocabulary is not the CLI's. Nothing here keys on that value.

## The reader

`toolCallRecord` plus `_noteToolCallWatch` / `_stepToolCallWindow` /
`_checkToolCalls` / `_automaticWriteReadiness`, all in `daemons/pty-runner.mjs`.
It reuses the existing bounded JSONL reader (`readCompleteLines`) and the
existing watch-object pattern.

**Carriers are measured, not guessed.** The only records carrying these blocks
in the captures were `assistant/tool_use`, `user/tool_result`, and
`api-request-blob/tool_result`. The blob is a replay of an API request payload,
not an event, so **settlement is read only from a top-level `"type":"user"`
record**.

That restriction is load-bearing, not tidiness. The blob's position relative to
the authoritative record is not stable. On 2.1.309 it followed. On 2.1.310 (live
run `2026-10-24T18:59Z`, session `a1b3a275`) it **preceded** it, by offset and by
0.76 s:

```
451495  assistant         18:59:02.114Z   tool_use     toolu_01Rhprv… (Glob)
453586  api-request-blob  (no timestamp)  tool_result  toolu_01Rhprv…
455821  user              18:59:02.870Z   tool_result  toolu_01Rhprv…
```

A reader that accepted the blob would release the call *early*, on a record the
host had not yet committed as the answer. Reproduced on the second 2.1.310 run
(session `e8cd53af`): offsets 451531 `assistant tool_use`, 453622
`api-request-blob tool_result`, 455857 `user tool_result` -- the blob again ahead
of the authoritative record.

**Paired by id.** One result settles its own call and no other. A cancellation or
error result settles its own call and authorizes nothing: readiness answers *may
an automatic write go out*, never *is a business action authorized*. The clear
stays gated on the cycle's capsule ack exactly as before.

**Anchored, so a bounded tail is enough.** The API cannot be called again while a
`tool_use` in the previous assistant message is unanswered. So a *new API
response* proves every call from earlier responses has been answered. That one
protocol fact lets a bounded tail read establish the whole outstanding set
without reading from byte zero, and it discharges both a restart's unknown prefix
and an oversize record stepped over.

**The anchor is a response, not a record**, and the difference is a fail-open.
One response is written as *several* top-level `assistant` records, one per
content block, sharing `message.id` / `requestId` and numbered by
`apiBlockIndex`. Measured in both captures:

```
blockIdx=0  reqId=req_011CgMaKpY…  msg.id=msg_011CgMaKpq…  thinking
blockIdx=1  reqId=req_011CgMaKpY…  msg.id=msg_011CgMaKpq…  tool_use
```

A response that issues **parallel** tool calls therefore lands as two records
carrying `tool_use` under one response id. A rule that cleared the set on every
`assistant` record would drop call A the moment call B's record arrived -- and
once B's own result settled B, the set would read *empty* with A's dialog still
on screen.

(The block splitting is measured. The parallel-call shape is *inferred* from it,
because both captures ran haiku issuing one tool at a time. `#104 D21` constructs
it from the measured record shape.)

So the anchor is scoped to the response identity, and that identity is **tagged
with the space it came from** -- `msg:<message.id>`, else `req:<requestId>`. A
record of a *different* response **in the same space** clears the set; a record
of the *same* response is a continuation block that adds its ids and clears
nothing; an unidentifiable record clears nothing either; and a record whose
space *differs* from the one currently held clears nothing either, because across
a space change the reader cannot tell one response from two.

That tag exists because the bare fallback was a fail-open on a **partial**
disappearance, not a total one: one response whose block 0 carried only
`requestId` and whose block 1 carried only `message.id` produced two different
strings, so block 1 read as a new response and cleared block 0's live call --
while nothing about the conversation had changed, only which field the host
happened to write. Latent (both fields were measured present on every assistant
record of both captures) but cheap to make impossible. `#104 D36`/`D37`.

The `unknownOpen` **discharge** needs more than that, because it claims calls the
window never saw are answered, and an earlier block of *this* response could have
opened one. Two independent proofs, either sufficient:

- `apiBlockIndex === 0` -- this record is the start of its response, so it has no
  earlier block;
- the **second** distinct response **since the unknown was raised** -- the first
  one's existence proved every call before it was answered, and the second proves
  every call of the first was answered. Together they cover the unknown prefix
  with no block index at all, which keeps the discharge working if that field
  ever changes.

**That second proof is only valid for the prefix of the count**, and getting
that wrong was a third fail-open. `responsesSeen` was a running total over the
whole scan and was never reset, so it was already ≥ 2 after the first few
records of any real tail -- the clause was effectively always satisfied. It is now
**reset whenever an unknown is raised mid-scan** (the oversize-record step
below), which restores the precondition the argument needs. `#104 D27`/`D28`,
with `D29`/`D30` holding the two liveness directions.

If both fields ever disappear from the format, the reader goes conservative
rather than permissive: no clear, no discharge, so a baseline reports
`tool-call-baseline-unanchored` -- loud and fail-closed. A *partial*
disappearance is covered by the space tag above, which is what makes that
sentence true rather than merely intended.

**A sidechain (subagent) response is not an anchor either**, and missing that is
the same fail-open by a second route. The anchor argument -- the API cannot be
called again while a call is unanswered -- holds only *within one conversation*. A
subagent is a different conversation driven by its own API calls, so its
responses prove nothing about the main conversation's outstanding calls. Measured
on a real `subagents/agent-*.jsonl` (2026-10-24), a sidechain assistant record
carries its **own** `message.id`, `requestId` *and* `apiBlockIndex`:

```
isSidechain=true  blockIdx=0  msg.id=msg_011CfyAoyz…  thinking
isSidechain=true  blockIdx=1  msg.id=msg_011CfyAoyz…  text
isSidechain=true  blockIdx=2  msg.id=msg_011CfyAoyz…  tool_use
```

So it satisfies **both** freshness and start-of-response, and an unscoped anchor
would clear -- and discharge the unknown prefix for -- a *main*-conversation call
whose dialog is on screen. Such a record therefore carries `response: null` and
`startsResponse: false`: it opens its ids and can neither clear nor discharge.
Its calls still **count**, deliberately, because a subagent's tool call raises the
same dialog on the same screen (`#104 D5`), and its own `tool_result` still
settles them by id. This is the same exclusion `isAckLine` and
`isCapsuleRequestRecord` already make, both added for #79.

On reachability, stated rather than implied: on binary 2.1.310 subagent records
are written to a **separate** `subagents/agent-*.jsonl` file and the bound
transcript holds none of them (0 `isSidechain:true` across six live main
transcripts), so this is defence for the **inline** shape rather than a live
defect fix. The inline shape is the one #79 had to exclude and the one `#104 D5`
asserts, so the reader does not get to assume it away.

**Restart while a call is pending** is covered by that tail read, and needs no new
persisted state. A new process cannot start its cursor at the transcript's end --
the pending `tool_use` would already be behind it and its answer would never be
seen either, so the set would read empty *forever*, not briefly. It also cannot
read from byte zero. It starts one bounded span back from the end and scans
forward. A persisted offset was considered and rejected: the persisted-offset
machinery exists for evidence that must not be re-read (re-reading an ack is an
authorization bug), whereas readiness is a live predicate re-derivable from the
tail. A persisted offset would only add a way for the record and the file it
indexes to disagree, which is #90 shape 1.

### No fail-open, by construction

Every one of these is a **named NOT-READY**, never an empty outstanding-call set:

| condition | code / reason |
|---|---|
| transcript path will not resolve | `tool-call-transcript-unresolved` |
| stat fails for any reason other than ENOENT | `tool-call-transcript-unreadable` |
| the path is not a regular file (directory, FIFO, socket) | `tool-call-transcript-not-a-file` |
| the file is absent, at a boundary not entitled to read that as "no records" | `tool-call-transcript-absent` |
| size is not a safe non-negative integer | `tool-call-transcript-size-invalid` |
| a window read throws | `tool-call-window-read-failed` |
| a marker-carrying line will not parse | `tool-call-record-unreadable` |
| a `tool_use` with no usable `id` | `tool-call-record-unreadable` |
| the bounded tail contained no anchor | `tool-call-baseline-unanchored` |
| a record larger than one window was stepped over | `tool-call-oversize-record-unread` |
| the cursor is short of the transcript end | `runner-tool-call-reader-behind` |
| one or more calls outstanding | `runner-tool-call-outstanding` |

A cursor short of the end covers both a record that is half-written *right now*
(it may be the `tool_use`) and a transcript that outgrew one bounded catch-up
pass.

**The oversize step has its own code on purpose.** "A record bigger than the
window went unread at offset N" and "the tail held no anchor" are different
situations with different operator answers, and the offset plus the unread byte
count are what make the first one actionable. They shared a name until `#104
D31`. The shape is ordinary rather than exotic: a `Write`/`Edit`/`MultiEdit`
whose `input.content` carries more than 256 KiB of file body is exactly the tool
that raises the dialog, and that record cannot be parsed in one window.

**Two residuals here are accepted rather than fixed, and both are liveness, not
safety:**

- a **degraded** reader holds every automatic write until the transcript grows by
  a further 256 KiB, because that is the condition for re-attempting the
  baseline. On a quiet seat a standing fault therefore holds automation for as
  long as the seat stays quiet. The alternative -- re-scanning the same megabytes
  every tick -- was the cost the growth gate was added to avoid, and the hold is
  named on every tick rather than silent.
- the **unreadable** branch stops at the offending record and advances the cursor
  to the end of the window it was reading, so the remaining complete records in
  that window are discarded unparsed. They are re-read only if the reader
  re-baselines. Conservative in the safety direction (the set is not updated from
  them), and the refusal is named.

**What this table does not cover, stated here rather than only in the residual
section:** a discharge is sound for the *main* conversation only. A
main-conversation anchor that discharges an unread region which held an inline
**sidechain** call is unsound, and is not blocked -- the mirror of the
sidechain-anchor exclusion. See residual (5); it is accepted because an unread
region's content is unknowable, not because it was overlooked.

**One case is positive evidence rather than ignorance:** a **zero-length**
transcript. The host has written no records, and a tool permission dialog cannot
exist without a `tool_use` record.

**ENOENT on a resolved path is positive evidence only at some boundaries**, and
treating it as universal was a sixth fail-open. Claude Code creates the
transcript with its first record, so "no file" does mean "no records" -- but
that is a fact about a **new** session. The capsule-request and clear boundaries
only fire for a session at ~80% context pressure, which provably **has** a
transcript, so absence there cannot mean "no records yet"; it means the path
mis-resolved (wrong session id, cwd or home). Answering ready wrote command text
plus a bare Enter into a session the runner could not see.

So the reader records the fact (`absent`) and each boundary decides whether it
is entitled to use it. `ABSENT_TRANSCRIPT_READY_AT` holds exactly one:
`wake-enter-retry`, whose window genuinely precedes the new session's first
record. Everything else, **including any boundary added later**, is strict, and
the refusal is `tool-call-transcript-absent`.

Strictness comes from the **boundary**, not from what the reader has observed.
The alternative -- permit absence until this binding has seen its first record
-- is boundary-agnostic and breaks on restart, where a fresh watch has seen
nothing and would permit exactly the mis-resolution case. A boundary survives a
restart; accumulated observation does not. `#104 D40`-`D44`.

Refusing the zero-length case would cost liveness and buy nothing. The one exposure they share
is a wrong `sessionId` pointing the reader at another seat's file; that is the
same exposure the ack scan already carries, bounded by the same boot/session
binding guard.

**A path that is not a regular file is neither of those**, and the distinction
was originally decided by a platform quirk rather than by the reader. Verified
on both: a directory stats as **size 0 on win32** and **40 on linux**. With 0,
the catch-up loop never runs, no read is attempted, no error is raised, and the
zero-length branch answers *ready* -- a fail-open. With 40 the read runs and
throws `EISDIR`. The reader now rejects the path for what it **is**, before
either outcome, so the two platforms agree and the permissive answer is gone.
ubuntu CI is what surfaced this; a Windows-only run cannot see the class at
all.

### Bounds

| bound | value | why |
|---|---|---|
| window | 256 KiB | the existing `CAPSULE_ACK_WINDOW_BYTES` |
| baseline span | 4 windows | the 2.1.309 capture's last anchor sat 177 KiB before the end of a 465 KiB file; 4× is headroom for an attachment-heavy tail |
| baseline reads | 8 | `readCompleteLines` consumes only to the last complete line, so 200 KiB records advance ~200 KiB per 256 KiB read; 4 reads covered only ~800 KiB of a 1 MiB span |
| catch-up reads | 4 per check | past that the verdict is `reader-behind`, not a stale answer |
| far-behind | > 4 windows | re-baseline from the tail rather than crawl |
| Enter deferrals | 150 | ≈ 1 minute at the default 400 ms delay |

**Far behind: jump, don't crawl.** Forward-only is load-bearing for the *ack*
reader. For readiness it is backwards: a position nearer the end is strictly
better evidence. A 2.5 MiB append arriving between two ticks left a crawling
reader at `reader-behind` for several ticks, holding writes with nothing to wait
for. Re-baselining converges in one tick at the same bounded cost, and keeps the
fail-closed property -- the jump sets `unknownOpen`, which only an anchor
discharges.

## The write paths, and how each is covered

Both mechanisms apply at every gated boundary and readiness requires **both**.
"transcript" is the #110 reader described above; "interlock" is the gate and
pending map described in *The bounded pre-permission interlock* below.

| path | what it writes | transcript | interlock |
|---|---|---|---|
| `_writeOperator` | the operator's own bytes | **not gated** | **not gated** -- see *The exemptions, re-examined* |
| `_fireCapsuleRequest` via `_writeCapsuleRequest` | `/context-capsule` | **gated.** Fresh read in `_writeCapsuleRequest`, immediately after the composer guard and *before* the ownership tally -- so a deferral does not spend the cycle_id latch. | **gate held** from after that read, across the ownership tally, to the text write. A refusal costs one tick and spends nothing. |
| `_writeCapsuleRequestEnter` | `CONTROL_ENTER` | **gated.** Fresh read at fire time. On a hold, rescheduled (see below). | **gated.** The pending re-read and the keypress are one critical section. On a hold, rescheduled identically. |
| `_writeControl` via `commitClearSubmission` | `/clear` | **gated** at `_prepareSubmission`, after the ack gate and before the token is minted: nothing is spent, no hold taken, no intent persisted. Not re-read at commit. | **gate held** from `_prepareSubmission` across the `scheduleCommit` turn to the text write. This is what closes residual (3). |
| `_writeControlEnter` | `CONTROL_ENTER` | **gated.** Fresh read at fire time, after the existing submission-phase guard. On a hold, rescheduled. | **gated**, same critical section as the capsule Enter. |
| `_fireWake` | `WAKE_MESSAGE` | **not gated, structurally.** | **not gated, structurally.** See *The exemptions, re-examined*. |
| `_writeWakeEnter` | `CONTROL_ENTER` | **not gated, structurally.** | **not gated, structurally.** |
| `_tickWakeSubmission` retry | `CONTROL_ENTER` | **gated**, and the one boundary where an *absent* transcript still reads as "no records" (`ABSENT_TRANSCRIPT_READY_AT`). Fresh read after the settle and budget gates. A hold does *not* consume the retry budget, so the owed retry still happens. | **gated.** A refusal inside the critical section *gives the retry back* (`watch.retries -= 1`), so the owed retry stays owed. |
| `COMPOSER_KILL_LINE` (`commitClearSubmission`, `_flushQueuedInput`) | `Ctrl-U` | **not gated** | **not gated** -- see *The exemptions, re-examined*, where the claim is now measured rather than asserted |

### Why a digit in an automatic literal would be a dialog answer

The ungated automatic **text** writes are safe partly for a reason that used to
be only a comment: `/clear`, `/context-capsule` and `WAKE_MESSAGE` contain **no
digits**. At the dialog a digit selects that option *directly*, so a literal
carrying a `2` would answer "Yes, and switch to accept edits … for this session"
with no Enter involved at all -- the worst outcome in this issue, reachable
without touching any of the Enter machinery above. `WAKE_MESSAGE` is prose and
could acquire a numeral in an ordinary edit ("run step 2 of the procedure").

It is an assertion now, evaluated at module load as well as in the suite
(`automaticTextLiteralProblem`, `#104 M6`). These are compile-time constants, so
the check can only fail because somebody edited a literal -- which is exactly
when a hard stop is wanted, and it can never fire from an environmental cause.
Refusing to load is louder and safer than launching a runner that can answer a
dialog by typing.

### Why the clear is not re-gated at commit, and what changed

The only refusal mechanism available in `commitClearSubmission` is
`_abortPrepared`, which is **terminal** (`automationEnabled = false`,
`phase = 'abandoned'`). It would kill automation for the rest of the session over
a dialog that resolves in seconds. So the transcript read is **not** repeated
there, and in #110 the one-scheduler-turn prepare-to-commit gap was reported as
residual (3) rather than closed with a guard whose only available outcome was
worse than the hazard.

**The interlock closes it, at a price that is part of the claim.** The gate is
taken in `_prepareSubmission`, before anything is spent, and **held** across the
`scheduleCommit` turn, so no permission marker can be recorded inside it.

But holding it is not sufficient on its own, and an earlier version of this
document said it was. The gate is a **file another process can take**, and it
was measured being taken from a live, legitimately-held span after a forward
wall-clock step. So `commitClearSubmission` also **re-verifies on-disk
ownership**, and if the gate is gone it aborts -- terminally, because that is
the only refusal available there. The consequence, stated rather than buried:
**a stolen gate costs the session its automation rather than one tick.** That is
the right way round (writing `/clear` plus an Enter on an unproven exclusion is
the defect) but it is a real cost and it is not free.

The gate is released from every exit of that span, `_abortPrepared` included.
See *The bounded pre-permission interlock* and *Exclusion can be lost* below.

### Why the wake text and its first Enter are not gated

Both fire inside `_rebindAfterClear`, onto a context the host has just torn down
and rebuilt. Nothing has been submitted to that context, so no `tool_use` can
exist and no tool dialog can be open. The hazard is structurally absent.

That window also precedes the new session's *first* transcript record -- the
deterministic suite asserts exactly that (`fs.existsSync(wakeTranscriptPath(h))`
is `false` at the wake Enter). ENOENT is read as the positive answer it is, so
the reader would not hold them either way, but the structural argument is the
load-bearing one.

The **retry** is different, and is gated. It fires on later ticks, after the first
Enter released the input hold and queued operator bytes went in behind it. The
operator's own prompt can be running by then, with a dialog up, while the wake's
record still has not appeared -- which is precisely the state the retry exists
for.

#### What gating the retry changed, and why that trade was taken

Gating it is a **contract change**, not just a new guard. An unreadable
transcript used to buy bounded retries and a `retry-cap` close; it now buys
none. The alternative was considered and rejected on its merits: letting the
retry proceed when the transcript cannot be read means treating *cannot read* as
*no tool call outstanding*, which is the substitution this whole document
exists to prevent. `EACCES` on a real file takes the identical code path as
`EISDIR` on a directory, so the permissive reading could not have been confined
to the harmless case.

Two things bound what that costs, and `W6`'s `unreadable` case asserts both
rather than leaving them to reasoning:

- **the first wake Enter stays structurally exempt**, so an unreadable
  transcript costs only the retries and never the post-clear resume itself;
- **the watch still closes by name.** `watch.ticks` increments at the top of
  `_tickWakeSubmission` on every tick regardless of the gate, so the close is
  `watch-budget` with `retries: 0` -- bounded at `WAKE_SUBMIT_WATCH_TICKS`
  (1200 ticks, about 120 s at the default interval), visible, and released. A
  silently parked watch would be a worse outcome than the one being prevented.

The suppressed retries are visible rather than inferred: each one logs an
`automatic-write-held` event at the `wake-enter-retry` boundary carrying the
reason, so the log says *why* the count stopped moving.

## The deferred Enter

The dangerous ordering: the text write has already placed command text in the
composer, and the dialog appears in the 400 ms gap **before** the Enter.

The Enter must not be written. It must also not be *dropped*, because dropping it
strands the line silently and then releases queued operator bytes onto it. So
`_deferAutomaticEnter` **reschedules** it: same token, same handle slot. Every
protection the two-phase write already had stays intact for as long as the
deferral lasts:

- `composerMayHoldControlText` stays **true**, so a later queued-input flush
  leads with a kill-line instead of concatenating onto the stranded text;
- `enterHandle` stays **non-null**, so `_flushQueuedInput` keeps queued operator
  chunks *behind* the pending Enter and nothing interleaves;
- the token is unchanged, so a clear submission beginning meanwhile still bumps
  it and the callback still becomes the no-op it should be.

At the bound (150 reschedules, ≈ 1 minute at the default delay) the Enter is
**not** written: the line is declared stranded by name
(`runner-automatic-enter-stranded`), the handle slot is released, and the flag
stays up so the kill-line protection fires on the next queued-input release.
Stranding loudly is the correct outcome, because the Enter is the defect. A
scheduler that throws or returns no handle during a reschedule is treated
identically.

### Operator input takes over a deferred Enter

Holding `enterHandle` non-null is how the deferral keeps queued operator bytes
from concatenating onto the stranded text -- and on its own that was **a mutual
wait**. `handleOperatorData` queues whenever `inputHold || wakeEnterHandle !==
null || enterHandle !== null || composerMayHoldControlText`, and
`_flushQueuedInput` returns early on `enterHandle !== null`. So in the dialog
case the deferral's only termination condition was the operator answering the
dialog, while the operator's answer was exactly what was being withheld.

It was never an indefinite lockout -- the tick path (`!inputHold &&
queuedInput.length > 0 && !_flushQueuedInput()`) flushes once the budget strands
the Enter, and the kill-line branch destroys the stranded text before releasing
the bytes -- but a bounded **≈ 60 s operator blackout at the one moment the human
must act** is not an acceptable price. Before this change that handle was
non-null for the 400 ms two-phase gap and the hold was imperceptible.

So operator bytes arriving while an Enter is **deferred** mean the operator is
taking over. That Enter is abandoned immediately: timer cancelled, token bumped
(a cleared-but-still-firing scheduler callback becomes a no-op), slot released,
cause named `runner-automatic-enter-operator-takeover` rather than left looking
like a budget expiry.

Four things that rule does **not** do, each one pinned by a vector:

- it does **not** hand the bytes to the child directly.
  `composerMayHoldControlText` is deliberately left up, so they go through the
  ordinary queue and `_flushQueuedInput` leads with the kill-line that destroys
  the stranded automatic text. `#104 D32` asserts the kill-line *index* precedes
  the operator bytes, so "delivered" cannot be satisfied by concatenation.
- it does **not** touch a **normally** pending Enter -- one that lands in 400 ms
  with no dialog involved. The no-concatenation invariant is correct there and
  the bytes still queue behind it (`D33`). Testing `enterHandle` alone would
  have broken this, which is why `enterDeferredAt` is separate state.
- it does **not** override an `inputHold` or a pending **wake** Enter: those are
  other automatic transactions owning the composer (`D34`).
- it does **not** skip `_abortPrepared`. An operator byte in the prepared window
  is still the #78 named halt.

The flush happens in the same call rather than on the next tick, because waiting
a tick is what made this a blackout.

## The residual window of the transcript reader

**A last-moment transcript read is not an atomic lock.** It proves no call was
outstanding *at the moment of the stat*. Between that stat and the `pty.write`,
the child may issue a `tool_use` and raise a dialog. No transcript evidence can
make that read atomic, and this document does not claim it is.

> **Read this section as the case for the interlock, not as the shipped
> residual.** (1) and (3) below are **closed** by the gate described in *The
> bounded pre-permission interlock*, and (2) is narrowed to the window before the
> hook process has taken that gate. The list is kept in full because it is the
> measurement that justified the second mechanism, and because every item is
> still exactly what the transcript leg *on its own* can and cannot do. The
> residual that actually ships is in *Residual, after the interlock*.

Precisely characterised, the transcript reader's residual is:

1. **The read-to-write race.** Sub-millisecond to a few milliseconds of
   synchronous work (stat, bounded read, parse, write). A call issued inside it
   is invisible to that write.

   **CLOSED by the interlock.** The decision and the write are now inside the
   same gate the hook must take to record a permission check, so a check that
   begins in that window is seen. `#104 D20` used to assert that the write went
   out and now asserts that it does not -- including in the shape the transcript
   reader cannot see at all, where the hook has recorded the check and the
   transcript holds nothing. The old concession survives as `#104 D20b`, moved
   to the one window that genuinely remains (residual (6) below).

2. **The transcript-versus-screen ordering.** The guard assumes the `tool_use`
   record becomes readable before the dialog can accept a keystroke. Two
   independent observations, both transcript-first:

   **This was measured the wrong way at first, and the correction matters more
   than the original figures.** A record's `timestamp` field is when the host
   *created* it, not when its bytes reached the file. The guard reads bytes. So
   the quantity that matters is **readability** versus screen, and these are the
   timestamp-versus-screen figures:

   | run | binary | `tool_use` timestamp | dialog on screen | timestamp lead |
   |---|---|---|---|---|
   | 2026-10-23T16:09Z | 2.1.309 | 55.083Z | 55.993Z | 0.91 s |
   | 2026-10-24T18:58Z | 2.1.310 | 49.439Z | ≤ 52.058Z (400 ms poll) | ≈ 2.2 s |
   | 2026-10-24T19:56Z | 2.1.310 | 42.352Z | ≤ 43.571Z (400 ms poll) | 0.82–1.22 s |
   | 2026-10-24T21:07Z | 2.1.310 | 34.987Z | ≤ 36.010Z (400 ms poll) | ≈ 1.0 s |

   On the first three runs the bytes *were* readable while the dialog was up --
   the driver's independent parser named the unpaired id at every sample, so
   readability and timestamp agreed. **On the fourth run they did not.** The
   `tool_use` record sits at offset 286521; the transcript was 283263 bytes at
   all three samples taken while the dialog was on screen, so the record was
   **not readable at any of them**. The file jumped to 447231 only after the
   cancellation, carrying the `tool_use` and its `tool_result` together. Created
   at 34.987Z, readable no earlier than 37.423Z and present by 39.628Z: a flush
   lag of **≥ 2.44 s** -- strictly, an interval of 2.436 s to 4.641 s, because
   both ends are fenced by the driver's 400 ms screen poll. The one-sided figure
   is a **bound**, not a measurement, and the upper end of that interval is not
   a lower end. The signal was absent for the entire time it mattered.

   So residual (2) is not a sub-millisecond race. The host's transcript writes
   are **buffered**, the flush is not announced, and its timing is not the
   record timestamp -- which makes this a window of **seconds** during which the
   evidence the guard depends on can simply not exist yet. One run in four,
   under ordinary load, on the binary this work was built against.

   The ordering is not contractual, nothing in the host documents it, and the
   dialog times are upper bounds set by the driver's 400 ms poll rather than the
   paint. Three samples with the same sign were never a guarantee; a fourth with
   the opposite sign settles it.

3. **The clear's prepare-to-commit gap.** One scheduler turn between the gate in
   `_prepareSubmission` and the `/clear` text write in `commitClearSubmission`.
   The transcript read was not repeated there, for the reason given above (the
   only refusal available is terminal), and the clear's Enter was gated.

   **CLOSED by the interlock**, and not by adding the guard that was rejected:
   the gate is taken in `_prepareSubmission` and **held** across that turn, so
   nothing can become pending inside it. `#104 I3` asserts it from inside the
   span -- a hook that arrives there is denied.

   It is closed by the held gate **plus** a commit-time re-verification that
   the gate is still ours on disk, because a live holder's gate can be stolen.
   `#104 I16`. The cost is that a stolen gate aborts the clear terminally.

4. **A transcript that goes away or shrinks under a live session with a dialog
   up.** ENOENT is read as "no records", which would be wrong in that
   pathological case. The same item covers a *truncate-and-regrow in place*:
   `_checkToolCalls` re-baselines when `size < watch.from`, but a file truncated
   and then regrown **past** the old cursor before the next check is never seen
   to have shrunk, so the reader keeps a cursor that indexes different bytes
   than it did. No observation of either; stated because neither is detected.

5. **A main-conversation anchor can discharge an unread region that held a
   sidechain call.** This is the mirror of the sidechain-anchor exclusion, and it
   is open. A subagent response is excluded from *being* an anchor (`#104
   D25`/`D26`) precisely because it proves nothing about the main conversation --
   but the converse also holds and is not blocked: a main-conversation response
   proves nothing about an outstanding *subagent* call, so when it discharges an
   unknown region that happened to contain one, the discharge is unsound.

   Accepted rather than fixed, because an unread region's content is by
   definition unknowable: the reader cannot tell whether the bytes it stepped
   over held a sidechain call, so there is no evidence on which to refuse
   specifically. Refusing *every* discharge instead would hold automation
   permanently on any transcript carrying one oversize record. The exposure is
   also narrower than it reads: on the measured binary (2.1.310) subagent records
   go to a separate `subagents/agent-*.jsonl` file and the bound transcript holds
   none of them, so this needs the inline sidechain shape that `#79` had to
   exclude and that `D5` asserts. Named here rather than left implied, since the
   leg that added `D25`/`D26` exists specifically to defend that shape.

### What would close (1) and (2) -- and what this change then did

Transcript evidence cannot close them: the transcript is a record of what the
child *did*, written concurrently with the dialog, not a lock taken before it.
Run 4 above makes that concrete rather than theoretical -- the record existed and
was simply not on disk yet, so no amount of care in the reader would have
produced the signal.

That raises the value of the alternative considerably. The flush lag bound
(≥ 2.44 s) is larger than the entire deferral window the guard relies on for its
second leg, so for that run the transcript route offered no protection at all.

The smallest **supported** host mechanism that would close them causally is a
`PreToolUse` hook. Claude Code runs `PreToolUse` before the tool call and before
the permission check, synchronously -- so a marker written there is *causally*
before the dialog rather than concurrent with it. This repository already uses
that mechanism (`daemons/gateguard.mjs`, `daemons/memory-budget-guard.mjs`,
`daemons/model-tier-guard.mjs`, wired in `.claude/settings.json.template`), so it
would be reuse rather than invention.

It was **not** in #110, deliberately, because keying readiness on a hook
marker is only sound if the runner can prove the hook is live in the bound
session. Absence of a marker would otherwise mean "no tool call" and "the hook
is not installed" -- indistinguishable, and the second reading is a fail-open
worse than the gap it closes. Establishing and verifying that installation
per-session was a larger change than a bounded repair, and shipping half of it
would have replaced a named residual with a silent one.

**It is in this change, with that proof built first.** The four evidence legs in
*Proving the hook is live for this bound session* are the answer to the paragraph
above, and the property they exist for is stated as plainly as it can be:
missing, stale or failed hook evidence makes automatic input stay **held**, and
never reads as "no tool call is pending".

## The bounded pre-permission interlock

Everything above reads the transcript. **Measured on binary 2.1.310, that signal
is not reliably on disk while the dialog is on screen** -- see residual (2) and
the run-4 figures. So the second mechanism does not read a record of what the
child *did*; it takes a lock the child's own permission check has to take too.

`daemons/pre-permission-interlock.mjs` is one file with two callers: run
directly it is the `PreToolUse` / `PostToolUse` / `Stop` hook, imported it is
the library the runner uses for the same gate and the same state file. That is
deliberate rather than tidy -- a mutual-exclusion protocol with two
implementations has two chances to disagree about what *held* means.

### Why a hook, and why it is causal rather than concurrent

Claude Code runs `PreToolUse` **before the permission check**, synchronously,
and waits for it. A marker written there therefore precedes the dialog instead
of racing it, and it does not depend on a flush the host never announces. The
repository already used this mechanism three times (`gateguard.mjs`,
`memory-budget-guard.mjs`, `model-tier-guard.mjs`, wired in
`.claude/settings.json.template`), so this is reuse.

The payload shape is **measured, not assumed** (2026-10-25, binary 2.1.310,
authenticated disposable profile, project-level `.claude/settings.json`):

| event | fields |
|---|---|
| `PreToolUse` | `session_id` `transcript_path` `cwd` `prompt_id` `permission_mode` `effort` `hook_event_name` `tool_name` `tool_input` **`tool_use_id`** |
| `PostToolUse` | the above plus `tool_response` `tool_use_id` `duration_ms` |
| `Stop` | `session_id` `transcript_path` `cwd` `prompt_id` `permission_mode` `effort` `hook_event_name` `stop_hook_active` `last_assistant_message` |

Two facts from that capture decided the design:

- **`PreToolUse` carries `tool_use_id`**, the same id the transcript reader
  pairs on. So a marker is keyed by the host's own identity for the call.
- **a DENIED tool call produces no `PostToolUse` at all.** The denied `Read`
  produced `PreToolUse` and nothing else; the allowed `Glob` produced both. So
  `PostToolUse` cannot be the clearing path for a cancelled dialog, which is
  exactly the case that has to recover. The turn's `Stop` is.

One more measured fact about the *wiring*: **project-level hooks are silently
ignored in an untrusted workspace** (`Ignoring 1 permissions.allow entry from
.claude/settings.json: this workspace has not been trusted`), and hooks supplied
through `--settings` did not run at all. The installed seat is a trusted
workspace with a rendered `.claude/settings.json`, which is the shape that works
and the shape the runner's wiring leg checks.

### Why this is a mutex and not a second file to poll

A second file the runner polls would have the identical defect one layer over:
the runner reads *nothing pending*, the hook then writes the marker, and the
runner writes its Enter into the dialog that follows. **A check followed by a
write is not exclusion.**

So both sides take the same gate:

```
runner:  acquire gate -> read pending -> pty.write(...) -> release gate
hook:    acquire gate -> (drain) -> record pending -> release gate
                                 -> the host's permission check proceeds
```

Whichever side holds it first, the other cannot interleave:

- **hook first** -- its marker is on disk and `fsync`ed before it releases, so
  the runner's `pending` read *inside its own critical section* sees it and the
  write never happens;
- **runner first** -- `pty.write` has already **returned** before the hook can
  acquire.

There is **no interval in which the runner can observe an empty pending map and
then have a marker appear before its own write**, because the observation and
the write are inside the same critical section the marker creation needs. That
is the whole of "no check-then-write race", and it is the property `#104 D20`
asserts (recorded after the readiness read, still held) and `D20c` asserts from
the other side (the hook cannot start a check inside the runner's span).

**That sentence is about the MARKER ordering, and it must not be read as being
about the BYTE ordering.** Two different things are being ordered here and
stating them in one breath is how the drain's limits got overclaimed:

| ordering | status |
|---|---|
| the runner's *observation* vs the hook's *marker* | **excluded** by the gate, as above |
| the runner's *byte* vs the dialog's *appearance* | **not excluded**, and not excludable -- see *The drain* |

The gate makes the decision and the write atomic with respect to the marker. It
says nothing about when the child reads its stdin.

The gate is held across **more than one scheduler turn** in exactly one place:
the clear's `_prepareSubmission` to `commitClearSubmission` span. Holding it is
what stops a permission marker being recorded inside the window -- and it is
**not** the whole of residual (3), because the gate can be taken from a live
holder (see *Exclusion can be lost*). The commit therefore re-verifies on-disk
ownership as well.

An earlier draft of this document said *"re-testing an invariant you are holding
is not a guard; it is a second chance to be wrong."* **That was wrong**, and it
is deleted rather than annotated: the invariant is another process's file, so
asking the disk is the only way to know. The sentence survived 450 lines ahead
of the place that retracted it, which is worse than simply being mistaken.

### The drain: what it buys, and what it does not

**`pty.write()` returning is not the child having consumed the byte, and no
supported mechanism can tell us that it has.** Measured against node-pty 1.1.0:
`write(data)` returns `void`, the underlying `net.Socket`'s backpressure boolean
is discarded, and there is no "input consumed" event. So the runner's write is
*causally* before the marker while the byte may still be travelling, and nothing
in the host closes that.

What the drain is, stated without overclaim: the runner records `last_write_at`
**inside the gate and before the write**, and a `PreToolUse` that acquires the
gate within `INTERLOCK_DRAIN_MS` of that stamp sleeps out the remainder before
recording and returning. That buys a **bounded quiet period** in which no
permission check may *start*.

Two things make that period smaller than the constant, and both belong in the
claim rather than in a footnote:

- **It is measured from the stamp, not from the byte**, and `writeState` sits
  between them. Measured on this host over 400 samples: p50 **1.5 ms**, p90
  1.8 ms, p99 2.2 ms, max 3.4 ms -- load-dependent. So the window actually
  available *after the byte leaves* is about **118 ms**, not 120.
- **It only applies when the hook reaches the gate within the period at all.**
  A tool call arriving long after the last automatic write gets no drain, and
  needs none: there is no byte in flight to wait out. The drain is not a blanket
  120 ms shield over every permission check.

So the residual is specifically the **near-coincident** case: *a dialog that
becomes renderable within the quiet period, on a child that has not yet read the
queued Enter.* It requires the child to be more than ~118 ms behind on reading
its stdin, which is **unobservable from here and unbounded in principle**. A
mitigation, not a discharged proof obligation.

The wait is the **hook's**, never the runner's. The hook is a throwaway process,
so a bounded synchronous sleep there costs nothing; a sleep in the runner would
stop it pumping the child's output.

**Which writes stamp.** The write-path table above lists **nine** automatic
writes. Five stamp: the capsule request's text and its Enter, the clear's text
and its Enter, and the wake retry. Four do not, and each for its own reason:

| write | stamps | why not |
|---|---|---|
| both `Ctrl-U` kill-lines | no | `Ctrl-U` is not a selection key and cannot answer the dialog (measured on a real dialog -- see *Host evidence*), so there is no keystroke to drain for |
| `_fireWake`'s `WAKE_MESSAGE` | no | structurally exempt: it runs on a context the host has just rebuilt, where no `tool_use` can exist |
| `_writeWakeEnter`'s first Enter | no | same exemption, same window |

(`_writeOperator` is the operator's own bytes and is not an automatic write at
all.) An earlier version of this paragraph said "five of the seven" and named
only the kill-lines, which read as a complete enumeration and was not one.

The `/clear` **text** write used to be a genuine gap here -- interlocked by the
held span but writing straight to the PTY, so a hook arriving right after
`/clear` reached the composer got no drain at all -- and it is now routed
through the same helper as the other four.

**A forward clock step skips the drain entirely, and that is not fixable here.**
With one wall clock, "120 ms have elapsed" and "the clock jumped 120 ms" are the
same observation. A **backward** step is handled -- a negative elapsed is not
evidence of anything, so it drains in full -- but the forward case is named as a
residual rather than papered over. The hook's own internal bounds are protected
from a frozen clock by an attempt ceiling (see below); the drain is not, because
there is nothing to count.

**Why not require the child's output generation to change instead of a timer.**
This was proposed as evidence of consumption rather than a proxy for it, and it
is declined, with reasons:

- the runner cannot block on its own output pump -- the event loop that would
  deliver the output is the one that would be blocked, and the gate release is
  synchronous;
- deferring the release to a later tick means holding the gate across ticks,
  which extends exactly the window that proved stealable (see *Exclusion can be
  lost*) and blocks the child's tool calls for a tick at a time;
- exporting the generation to the hook needs a per-tick state write, ~10/s, so
  that a throwaway process can read it;
- and output generation is evidence of *some* output, not of *this byte* -- the
  child repaints constantly -- so it would be a second unproven proxy rather
  than proof.

The timer stays, the claim is reduced to what it can support, and the residual
is named.

### Bounded waits, and which direction the fallback fails

| bound | value | what it bounds |
|---|---|---|
| `HOOK_GATE_BUDGET_MS` | 1200 ms | how long `PreToolUse` waits for the gate |
| `GATE_SLEEP_MS` | 5 ms | one wait step (`Atomics.wait`, not a spin) |
| attempt ceiling | `budget / 5 + 2` | the **second, independent** bound -- see below |
| `INTERLOCK_DRAIN_MS` | 120 ms | the drain |
| `GATE_STALE_MS` | 5000 ms | when a gate may be stolen on age alone |
| `PENDING_MAX` | 64 | entries in the pending map |
| runner gate attempts | 2 | the runner never *waits*; one attempt, one steal, one retry |
| hook `timeout` in the template | 8 s | the host reads this field in **seconds** (an earlier cut wrote 8000, read as 8000 seconds, about 2.2 hours, effectively unbounded); 8 s is well above the sum, because a hook the **host** times out is a fail-open |

**There are two independent bounds on the gate wait, and the second is not
belt-and-braces.** A deadline alone makes "no unbounded hook wait" contingent on
the clock advancing: a frozen or non-monotonic clock makes the deadline
unreachable and the loop infinite, which is the agent hanging on a hook. A
vector that injected a constant clock found exactly that (it looped instead of
denying), so an attempt ceiling now holds whatever the clock does. `#104 G5`.

**The fallback fails closed.** If `PreToolUse` cannot take the gate inside its
budget, or cannot write the marker, or throws after finding a managed runner, it
returns `permissionDecision: "deny"` with a named reason and exits 2. The tool
call does not run, so **no dialog appears**, so there is nothing for an
automatic keystroke to answer. A denial is recoverable -- the model is told why
and can retry -- whereas an automatic *"Yes, and switch to accept edits … for
this session"* is not. This is the one `PreToolUse` hook in the repository that
does **not** fail open, and the reason is that its entire job is to be why an
automatic keystroke was held; a throw means it did not do it.

`PostToolUse` and `Stop` do **not** deny. Their failure mode is that a marker is
not cleared, which *holds* automatic writes -- already the safe direction -- so
denying there would cost liveness and buy nothing. `#104 G6`.

A gate nobody released is a liveness hazard in that same closed direction, so it
is **stealable**: a holder whose pid is gone, whose nonce belongs to a previous
binding, or that is older than `GATE_STALE_MS`. A legitimate holder cannot reach
that age -- the runner's critical section is a stat, a small read and a
`pty.write`. The steal is a **rename-away**, because that is the atomic step:
exactly one of several concurrent stealers can move the same source. Unlink then
create is not atomic and would let two stealers both believe they hold it.

### Platform semantics, measured on both sides

The #110 round lost a day to a Linux-only regression because `statSync(dir).size`
is 0 on win32 and 40 on linux. A Windows-only run cannot see the POSIX branch of
an `open`/`stat` distinction, so every primitive this unit depends on was
measured on both. WSL has no native node (only `/mnt/c`'s `node.exe`, which runs
as a Windows process and so could not see this branch at all), so the POSIX side
was measured at the **syscall** level with python3 -- which is what node's `fs`
maps onto: `'wx'` → `open(O_WRONLY|O_CREAT|O_EXCL)`, `renameSync` → `rename(2)`,
`process.kill(pid,0)` → `kill(pid,0)`.

| primitive | win32 (node 24.15.0) | linux (WSL2 6.18.33.2, python 3.14.4) |
|---|---|---|
| second `O_CREAT\|O_EXCL` open | `EEXIST` | `EEXIST` |
| `O_CREAT\|O_EXCL` on a **directory** | `EEXIST` | `EEXIST` |
| `stat(dir).size` | 0 | 40 |
| read of a directory | `EISDIR` | `EISDIR` |
| unlink while another process holds the fd | ok | ok |
| 4 processes racing to `rename` one source, 20 rounds | 20 wins total, losers `ENOENT` | 20 wins total, losers `ENOENT` |
| `kill(pid, 0)` on a dead pid | `ESRCH` | `ESRCH` |
| small file written + `fsync`, read from another process | immediate | immediate |

#### The path spelling the installer renders, and who converts it

`install.sh` renders every hook command and `env.AIGENT_ROOT` through `abspath`
-> `cygpath -u`, so a real Windows `.claude/settings.json` carries the **MSYS**
spelling. Verified on two independently installed trees on this host:

```
node "/c/aigent-recovery/canary-seat/daemons/sessionstart-reinject.mjs"
env.AIGENT_ROOT = "/c/aigent-recovery/canary-seat"
```

**That broke the wiring leg, totally, on the platform the product runs on.** The
anchored match added to stop a foreign install's hook counting compared raw
strings, and `"/c/..."` does not contain `"c:/..."` -- so a correctly installed
Windows seat read as `interlock-hook-not-wired` on every tick and held every
automatic write for ever. The suite could not see it because the fixture wired a
**native** path, a shape the installer does not produce; and the anchoring
vector's own counterexample had the same *form* as a real install, so the vector
proving "another install's copy does not count" would also have rejected this
install's own copy. Both spellings are now canonicalised before comparison, the
fixture renders the MSYS form **by default**, and `#104 I20` pins both
directions. With the faithful fixture, the pre-fix matcher fails 175 of 312
vectors -- the defect goes from invisible to unmissable. (Reverting only
`comparablePath`'s body on a clean tree reproduces exactly that: 136 pass, 175
fail, against 311 pass and 0 fail.)

**A narrower sibling, from the same renderer.** `install.sh`'s
`shell_double_quoted` *escapes* backslashes, so an install made where `cygpath`
is unavailable can carry `node "c:\\dev\\daemons\\..."`; unifying separators
turned that into `c://dev//...`, which matched nothing. Repeated separators are
collapsed now, with one carve-out and one decision.

**The carve-out:** a `//` at a token boundary is preserved, because that is a
UNC prefix and flattening it would make two different roots compare equal. The
first version of this tested `startsWith('//')` on the *whole value*, which only
fires when the value IS a bare path -- true of the resolved sibling, false of a
settings command, which begins `node `. So a quoted UNC prefix got flattened and
**a share named `c` matched drive `C:`**: a loosening of exactly the property the
anchoring exists for, introduced by the fix for a rejection bug, which is the
recurring shape of this whole issue. The detection is per token now, on the same
boundary the drive-fold keys on. `#104 I22`.

**The decision:** `//c/dev/...` is **ambiguous by construction** -- it is both a
doubled-MSYS path and a UNC share named `c`, the same string with two meanings.
It is therefore **rejected**. When a form cannot be told apart from a foreign
root, the safe reading is the rejecting one; the cost is that an exotic
doubled-MSYS spelling reads as not-wired, which is fail-closed and named, and no
renderer in this product produces it (`cygpath` emits single slashes). UNC paths
are otherwise **not handled** by this matcher, stated here rather than
half-supported in silence. `#104 I21`.

**And the question that followed it, settled by measurement rather than
reasoning.** If the hook process received `AIGENT_ROOT` in MSYS form, the
shipped resolver would turn `/c/...` into a **drive-relative** path
(`\c\...`), the hook and the runner would resolve *different* interlock roots,
and the whole mechanism would be inoperative: the hook silently inert for want
of a proof, the runner holding automation on `interlock-hook-not-observed` for
ever -- a refusal an operator would read as "this session has not had a turn
yet". (That misreading is now harder to make: every interlock refusal carries
the interlock directory the runner actually resolved, so a root divergence shows
up in the log instead of looking like a warming-up seat.)

Measured on binary **2.1.310**, on the authenticated disposable profile, with
the rendered shape in **both** the command and the env, by making the hook
**create the directory it would use** and looking at where that landed:

| | rendered in settings.json | received by the hook process |
|---|---|---|
| command path | `node "/c/dev/.../n10-probe.mjs" PreToolUse` | `argv[1] = C:\dev\...\n10-probe.mjs` |
| `AIGENT_ROOT` | `/c/Users/.../p104/proj` | `C:/Users/.../p104/proj` |

Both arrive **native**: the host converts them before the hook sees them, so the
hook and the runner resolve the same root, and the directory landed in the
correct place.

**The positive observation is what carries this.** The run also found no `C:\c`
afterwards, and the probe did remove any existing one first, so for that run it
is a real negative control -- but `C:\c` pre-existed on this host (empty), so
the absence is weak evidence on its own and is reported as a check rather than
as the finding. **Scope, as for every host observation here: one binary, one
host configuration**, the same epistemic status as the 75 ms marker lead and the
cancelled turn that fired no `Stop`.

**Checked, not assumed** -- and the wiring fix deliberately does not depend on
it, because the runner reads the settings *file* directly, with no shell in
between, which is why it has to understand the MSYS spelling itself. If the host
ever stopped converting, N10 would become a live defect and the wiring fix would
be unaffected.

#### One more platform divergence, found by CI rather than by us

The wiring work above was all about how a path is *spelled*. A separate hazard is
how a path is *constructed*, and it cost two vectors their Linux run: the module
suite derived the hook's location with `new URL(import.meta.url).pathname.slice(1)`.
A file URL's pathname carries a leading slash on both platforms, so the slice
gives `C:/dev/...` on win32, which **is** absolute, and `home/runner/...` on
POSIX, which is **not** -- after which `path.resolve` prefixes the working
directory and yields a doubled root. `fileURLToPath` is correct on both and is
what the production code already used, so this was never a product defect, only
a test that could not run where the product can.

**The class was ruled out for `comparablePath` explicitly**, because it would be
easy to assume: the drive-fold requires a **single-character** first segment, so
`/home/...`, `/opt/...` and `/usr/local/...` are all left untouched and matching
is unaffected. The one consequence worth naming is cosmetic: a POSIX root whose
first segment is a single letter (`/x/...`) folds to `x:/...`. Both sides of the
comparison go through the same transform, so it still matches; the only thing it
makes equal is POSIX `/x/foo` and win32 `X:/foo`, which cannot coexist on one
host because `wanted` comes from the runner's own resolved sibling.

Two further Linux failures were found by **looking for the class** rather than
waiting for CI to report them: an assertion that the fixture carried the MSYS
spelling was written as a literal `/"\/[a-z]\//` regex, which cannot match a
POSIX path; and a `slice(3)` intended to drop `C:/` mangles `/home/...` into
`me/...`. The path-spelling vectors now use **fixed synthetic roots**, one
win32-shaped and one POSIX-shaped, so the matcher is exercised as the pure
string logic it is and each platform tests the other's root shape.

The fix is verified on **real Linux** rather than by reasoning: a container
reproduces the pre-fix failure as exactly those two vectors and nothing else,
and the fixed tree is green on both suites.

The two platforms agree on every primitive the gate uses. The one place they
differ -- `stat(dir).size` -- is **not** used: a gate path that is a directory is
rejected for what it *is* (`interlock-gate-path-unusable`), before either
platform's size or error can decide it. Without that branch the gate would read
as permanently held and every tool call in the session would be denied for ever:
fail-closed, but a nameless wedge. `#104 G4`.

### Proving the hook is live for *this* bound session

This is the property the whole unit rests on, and the reason #110 did not take
this route. Keying readiness on a marker is sound **only** if the runner can
prove the hook is running for the bound session. Otherwise "no marker" means
both *no tool call* and *the hook is not installed*, and the second reading is a
worse, silent fail-open than the gap being closed.

Four legs, **all required**, each with its own refusal:

| leg | what it proves | how | refusal |
|---|---|---|---|
| 1 **bound** | the evidence belongs to *this* binding | `proof.json` exists in this session's directory and its `nonce`, `session_id` and `runner_pid` match the binding in memory | `interlock-proof-missing` / `-unreadable` / `-mismatch` |
| 2 **installed** | the hook is the file the proof was written about | the recorded path still exists and its sha256 still matches | `interlock-hook-missing` / `interlock-hook-changed` |
| 3 **observed** | the **host** has actually invoked **`PreToolUse`** for this nonce | `state.json` carries this nonce and `pre_runs >= 1` -- *or* the reader has parsed no `tool_use` at all, in which case a `Stop` or `PostToolUse` suffices | `interlock-hook-not-observed` |
| 4 **current** | the hook has not stopped running | since the last point at which both counters agreed, `pre_runs` has advanced at least as far as the transcript reader's `tool_use` count -- or, if it has advanced at all, the shortfall is forgiven and re-anchored | `interlock-hook-missed-tool-calls` |

Plus `interlock-hook-not-wired`: the hook must appear under `PreToolUse`,
`PostToolUse` **and** `Stop` with a matcher that matches every tool (`""`, `"*"`
or `".*"`), in **one** settings file the runner can read.

Which files those are depends on `CLAUDE_CONFIG_DIR`, and getting that wrong was
a defect found in a *different* track (#103, where a plugin detector always read
`~/.claude/settings*.json` while the host was using the overridden directory)
and read straight across to this leg:

| level | file | moved by `CLAUDE_CONFIG_DIR`? |
|---|---|---|
| project | `<cwd>/.claude/settings.json` | no |
| project | `<cwd>/.claude/settings.local.json` | no |
| user | `<CLAUDE_CONFIG_DIR>/settings.json`, else `<home>/.claude/settings.json` | **yes** |

**One profile, not both.** Scanning `~/.claude` *as well* when the override is
set would let a hook wired in the **unused** profile satisfy the leg, which is
the false-positive direction. `~/.claude` is the fallback only when the override
is unset -- which is what the host itself does.

**Both directions were constructed before the fix, because guessing is what
produced every fail-open in this issue, and the composed outcome differs from
the leg's own verdict:**

- **The false positive did not reach a fail-open** -- and for a stronger reason
  than the one it was worth checking. With the hook wired only at `~/.claude`
  and the host reading the override, the wiring leg *did* pass on an unused
  profile; but `state.json` is written **only by the hook** (or by an interlocked
  write, which requires readiness to have already passed), so with no hook
  running there is no state file and the chain stops at
  `interlock-state-missing`. **Leg 3 is never reached**, so leg 3's "no
  `tool_use` in the tail" exception could not be the door: it sits behind a
  precondition that never opens. This is the composed-evidence design working,
  and `#104 I23` asserts it rather than arguing it.
- **The false negative was the one that bit.** With the hook wired at user level
  *inside* the override profile -- the profile the host actually reads -- the leg
  reported `interlock-hook-not-wired` on a correctly configured seat and held
  automation for ever. Fail-closed, but nothing detected or lifted it.

**The shipped install shape was never affected.** `install.sh` renders into
`<root>/.claude/settings.json`, which is project-level, and the override moves
the user directory and not the project one. Measured on this host rather than
assumed: the hook-payload capture and the N10 run both used `CLAUDE_CONFIG_DIR`
with a project-level `.claude/settings.json`, and the hooks fired.

**Leg 3 is the strong one and the only empirical one.** It is direct evidence
that this binary, with this configuration, invokes this file for this session.

It used to accept `pre_runs + post_runs + stop_runs >= 1`, and that was too
weak in a way that mattered: **`stop_runs` alone proves the file runs, not that
`PreToolUse` is wired** -- and `PreToolUse` is the only invocation that protects
anything. Combined with the wiring leg being memoised (below), a `Stop` recorded
*before* someone unwired `PreToolUse` would keep legs 1/2/3 passing while
nothing stood in front of the dialog. Worse, leg 4's detector counts from
transcript **bytes**, whose flush lag was measured at ≥ 2.44 s with the record
absent for an entire dialog -- so for the first dialog after a `PreToolUse`
outage **both** mechanisms would be blind at once, which is the one combination
the two-mechanism design exists to exclude.

So leg 3 now requires `pre_runs >= 1`, with one narrow exception: a binding
whose reader has seen **no `tool_use` in the tail it has read** has no evidence
that a `PreToolUse` was owed, so a `Stop` is the only evidence obtainable.
Without that exception a seat that reached pressure on a single pasted document
would be held for ever, which is a liveness bug rather than a safety property.

**The premise is narrower than "this session has made no tool calls", and the
earlier wording overstated it.** `toolUsesObserved` counts only the bounded tail
*this binding* has parsed, and it is zeroed on rebind -- so it is evidence about
what the reader has seen, not about the session's whole history. The exception is
therefore "nothing owed that I could have seen", which is weaker but is what the
counter actually supports.

**Leg 4 is staleness detection without a timeout, and that is deliberate.** Idle
time proves nothing: a quiet session makes no tool calls, so an idle-staleness
rule would hold automation on a perfectly healthy seat -- a liveness bug dressed
as a safety check. What *is* proof is a `tool_use` the reader has parsed that the
hook never ran for, because on a wired seat every tool call runs `PreToolUse`
first. `#104 I5`.

**And the deficit it raises must not be permanent, which it was.** The
comparison re-anchored only on a *pass*, so one missed `pre_runs` increment was
never forgiven: five consecutive healthy calls still refused, the capsule
request and the clear stayed refused for the rest of the session, and the seat
never auto-cleared at pressure again. A **permanent automation outage**
recoverable only by restart -- which is precisely what the owner accepted
fail-closed *in principle* and explicitly did not accept. Two changes:

- **every `PreToolUse` invocation now counts, including the ones that deny.**
  `pre_runs` means "PreToolUse ran", and on a gate-busy, overflow or
  state-write-failure denial it demonstrably did. That removes most causes of a
  dropped increment.
- **a shortfall is forgiven on positive evidence, never on a timer.** Leg 4
  exists to catch a *dead* hook. If `pre_runs` has advanced at all since the
  agreement point, the hook is demonstrably alive and the shortfall is a dropped
  increment (a host timeout on the hook, a crash mid-invocation), so the
  checkpoint is re-anchored and the leg passes -- **loudly**, as
  `interlock-deficit-forgiven`, because it resolves in the permissive direction
  and a silent permissive transition is exactly what this issue keeps finding.
  If `pre_runs` has **not** advanced while the reader keeps parsing new calls,
  the hook is dead and this refuses for as long as that stays true. `#104 I18`,
  `G12`.

The earlier text here said "the next tool call makes the counters disagree and
the gate closes", which read as self-healing when it was not. It is now.

The comparison is a **delta against a checkpoint**, not an absolute total,
because the two counters are not comparable in absolute terms: the reader's
baseline walk parses up to a megabyte of *history* whose calls the hook handled
before `state.json` existed. The checkpoint is advanced every time all four legs
pass, and **discarded on every re-baseline** -- after a re-baseline the reader
has re-read records it already counted, so it has no claim about what the hook
owed. That forgiveness is not a hole: a re-baseline also raises `unknownOpen`,
which holds every automatic write until an anchor discharges it, so the two legs
cover each other.

**What is NOT a leg.** A runner-side probe -- spawn the hook with a synthetic
payload and check it stamps -- was considered and dropped. It proves the file
works when the **runner** runs it, which leg 3 already subsumes with strictly
better evidence (the **host** ran it), and it would cost a subprocess per bind
on a host that carries ~130 node processes at steady state. Earlier diagnosis
was the only thing it bought.

### The one absence that is not a fail-open

If there is no `proof.json`, the hook exits 0 and marks nothing. That is not a
hole, because the runner's side **requires the proof it writes itself**: absence
holds automatic writes on one side and silences the hook on the other. The two
refusals are the same fact seen from both ends, and an unmanaged seat does not
get its tool calls denied by a runner that is not there. `#104 G7` asserts both
halves together.

`AIGENT_INTERLOCK=off` works the same way: the hook goes inert **and** the
runner's side reports `interlock-disabled`, a refusal. The switch cannot create
a fail-open in either direction -- turning the interlock off stops automatic
writes, it does not permit them. `#104 I4c`.

### Clearing a marker, and why age never releases one

| path | covers | measured |
|---|---|---|
| `PostToolUse` for the id | an allowed call that ran | yes -- the allowed `Glob` produced one |
| `Stop` sweep | **every** other outcome: denied, cancelled, errored, abandoned | yes -- the denied `Read` produced **no** `PostToolUse`, so this is the load-bearing path for the case that has to recover |
| nonce rotation | a rebind, a relaunch | the new binding ignores the old directory entirely |

The `Stop` sweep is sound because `Stop` fires when the assistant has finished
responding, and a permission dialog cannot be on screen then -- the turn it
belongs to has ended. That is what bounds an orphaned marker to the turn it was
raised in.

**Age never releases a marker.** A human can read a dialog for minutes, and age
cannot tell that from a marker nothing ever cleared, so past
`INTERLOCK_PENDING_STALE_MS` (120 s) only the **name** changes --
`interlock-permission-pending` becomes `interlock-pending-stale` -- and both
hold. The rename exists so an operator can tell the two apart in the log. An
age-based release would be this entire issue with a timer on it. `#104 I9`,
`G13`.

### The exemptions, re-examined

#110's three exemptions were inherited rather than assumed, and each was
re-decided against the new mechanism.

**The operator's own bytes (`_writeOperator`): still exempt, and now for a
second reason.** They are the operator's keystrokes; their Enter at a dialog is
their decision. Gating them would make the runner swallow operator input -- and
under the interlock it would do worse, because a pending marker is cleared by
the operator answering the dialog, so gating their bytes would be the mutual
wait #110 already shipped once and had to fix. `#104 I7` drives the operator's
byte through with a check pending and asserts it reaches the child **in the same
call**.

**Both `Ctrl-U` kill-lines: still exempt, and the claim is now measured rather
than asserted.** #110 said "`Ctrl-U` is not a selection key and cannot answer the
dialog". That was an assertion about a host UI. The host driver now sends a real
`Ctrl-U` at a real permission dialog and records whether the dialog survives it
(see *Host evidence*). The structural reasons stand too: the kill-line *is* the
stranded-text protection, and it is written on the operator-release path, so
gating it would make the human wait.

**The post-clear wake text and its first Enter: still exempt, structurally, and
the claim is now testable.** They fire inside `_rebindAfterClear`, onto a context
the host has just torn down and rebuilt, so no `tool_use` can exist. What is new
is that the interlock gives that claim an observable: the new binding's pending
map is the host's own record of whether a check is in flight, and at that moment
the directory does not exist at all. `#104 I8` asserts exactly that.

And the exemption is **not a hole**, which is the part #110 left to reasoning.
The only route to the wake is a clear whose Enter went out, and that Enter is
interlocked: a check pending there means no submitted clear, which means no
rebind, which means no wake. `#104 I8b` constructs that chain.

The reason the wake pair could not simply be gated as well: the observed leg
cannot be satisfied by a session that has not had a turn yet, and `_fireWake`'s
only failure mode is terminal disablement. Holding the post-clear resume on
missing evidence would cost the seat its recovery for a hazard that is
structurally absent. The **retry** is different and is gated, exactly as in #110.

### No permanent tool outage

The interlock denying is correct. A denial no human can lift is a different
thing: a **permanent tool outage**, which the owner accepted fail-closed *in
principle* and explicitly did not accept. So the reachable deny states were
**enumerated by reaching each one against the shipped hook**, not reasoned
about, and the table's last column is the point.

| state | reached by | self-clears? |
|---|---|---|
| **T1** gate busy, live holder, young | the runner mid-write | **yes** -- the holder releases, in microseconds |
| **T2** gate busy, holder pid dead | a hard kill mid-span | **yes** -- pid-liveness steal, immediate |
| **T3** gate busy, holder nonce from a past binding | a rebind left a gate | **yes** -- nonce steal, immediate |
| **T4** gate busy, pid recycled to a live process | hard kill + pid reuse | **yes** -- age steal after `GATE_STALE_MS` |
| **T5** gate busy, live holder, `ts` not a number | a corrupt or hand-written gate | **no** -- the age clause is guarded on `Number.isFinite(ts)` |
| **T6** gate busy, clock behind the gate stamp | a clock change, a resumed VM | **no** -- `now - ts` is negative for ever |
| **T7** gate path is a **directory** | filesystem damage, operator error | **no** -- refused by design; waiting cannot turn a directory into a lock file |
| **T8** gate not creatable (`EROFS`/`EACCES`) | a mount gone read-only | **no** -- no code here repairs a filesystem |
| **T9** state not writable | same | **no** |
| **T10** pending map at `PENDING_MAX` | 64 unresolved checks in one turn | **yes** -- the turn's `Stop` sweeps |
| **T11** `state.json` unreadable | a corrupt or locked state file | **no** -- a consequence of the fix that stopped an unreadable state being replaced by an empty one: nothing repairs it, because the clearing events deliberately refuse to clobber it |
| **T12** the hook itself threw | a defect in the hook | **no** -- and **not reachable from `runHook`**: this code is produced by `hookMain`'s catch, which maps any throw to it. Listed because it is a real deny state of the hook as installed, declared rather than observed |
| **T13** the call cannot be attributed to a session | a renamed or absent `session_id`, or `readStdin` swallowing an error | **no** -- but **manual path 1 lifts it**, which is why `anyManagedSession` requires a *live* `runner_pid` and not merely a proof file |
| **T15** the interlock directory cannot be created | a mount gone read-only | **no** -- same class as T8/T9 |

Twelve of the fourteen deny; **nine have no self-recovery**: T5, T6, T7, T8,
T9, T11, T12, T13, T15. `#104 G18` builds every row and asserts that list, so if
it **grows** a new permanent-outage state has been introduced and needs a path,
and if it **shrinks** something started self-clearing -- which has to be a
decision rather than a side effect, because a state that quietly begins allowing
is the fail-open.

**This table was four rows behind that vector for a round**, and that is worth
recording rather than quietly correcting: the code and the vector were fixed and
the *record* was not, so an operator reading this page saw five permanent deny
states where there were nine, and never learned about `interlock-state-unreadable`,
`interlock-hook-threw`, `interlock-no-session-id` or `interlock-gate-dir-failed`.
The table's whole purpose is to make "no permanent tool outage" legible to a
human, so the record is the half that matters to the human.

**And the vector itself had the same disease one level up.** Its T12 row handed
the recorder a hand-written `{action: 'deny', code: 'interlock-hook-threw'}` next
to an assertion that could not fail, so the row counted toward the deny total,
the no-self-recovery list *and* the derived coverage set on the strength of a
literal. A row now has to come from a verdict that was actually observed, or
call itself a **declaration** and say why -- and T12 is the one declaration.

**`interlock-dir-unresolved` is deliberately absent from the table**: attempting
to build its row proved it is reachable only as *inert*. Denying requires a
resolvable interlock root, and with one, `sessionDir` returns null only for a
session id that has already been rejected a line earlier.

T5 and T6 are the mirror image of the age clause doing its job: it is
deliberately not a "give up and allow" timer, so anything that puts the
comparison out of action removes the gate's only self-recovery.

#### Two manual paths, and each covers what the other cannot

**(1) Stop the managed runner.** A proof whose `runner_pid` is no longer alive
means there is no managed runner, so the hook goes **inert** and tool calls
proceed. This is the only recovery that **needs no write at all**, which is what
makes it the answer to T8 and T9 -- a human cannot write a release file onto a
read-only filesystem.

*Is that an automatic self-clear?* No, and the distinction is the whole point.
It is not time-based, and its trigger is not "the protection has been
inconvenient for long enough" -- it is **"the writer this protects against does
not exist"**. The interlock exists to stop the runner putting an automatic
keystroke into a permission dialog; a runner that is gone writes nothing, so the
denial has no subject. Permission checking is untouched: the host prompts
exactly as it would with no interlock installed. Its honest limit is pid
recycling, which is why this is not the guaranteed path -- and it is also listed
as residual (12), because it is a new *allow* path.

**(2) The manual release.** A human writes `interlock-release.json` into the
session's interlock directory, most easily through the shipped subcommand:

```
node <AIGENT_ROOT>/daemons/pre-permission-interlock.mjs --release <session-id> "<reason>"
```

Both arguments are required and neither has a default: a release with no reason
is not auditable, and one with no session id would have to guess which seat to
give up on. It refuses rather than guessing, and it **refuses to write into the
wrong tree** -- the root is resolved from `AIGENT_ROOT`, `CLAUDE_PROJECT_DIR` or
the CWD, so without that check an operator running it from the wrong directory
would get a cheerful success having released some *other* install while the seat
they meant to recover carried on denying. The session's `proof.json` is the
evidence that the directory belongs to that session.

From then on, for that binding:

- the **hook** stops denying and stops marking. It takes no gate, writes
  nothing, and expresses **no permission opinion** -- the call goes to the host's
  own check, and the dialog appears and is answered by the human exactly as it
  would without the interlock;
- the **runner** refuses every automatic write, by name
  (`runner-interlock-released`), and that refusal is **latched**. Deleting the
  release file does **not** re-enable automation, because a release is a
  decision about the binding and not a toggle. Only a new binding -- a restart,
  or a post-clear rebind, each a deliberate human act with a new session id and
  therefore a new directory -- starts over.

**Why this is not the silent fallback the owner refused.** The protection is not
disabled, it is made **unnecessary**: the hazard is an automatic keystroke, and
after a release there are no automatic keystrokes. The release trades automation
for availability, explicitly, in writing, with the operator's own reason
recorded in the file and in the daemon log. It cannot be reached by accident
(a bare `touch` is not a release, nor is a file from another session, nor one
with a blank reason -- every near-miss keeps denying and **says which way it was
wrong**, so an operator who got the file wrong learns it on the call still being
denied rather than concluding the mechanism does not work). It cannot be an
environment default, because it is a file in a session-scoped directory rather
than a variable. And both sides name it: the hook writes a line to the daemon
log on **every** invocation it applies to, which on a released seat is one line
per tool call -- the honest record of a seat running without the protection.

`#104 I11`, `I11b`, `I12`, `I13`, `I15`; `G19`–`G23`. Each of those asserts all
three of the owner's conditions together, because a vector that only proved the
wedge clears would be the fail-open version of this feature: **(a)** the
operator can proceed, **(b)** automatic runner writes are still refused by name
at every boundary, **(c)** permission checking is still armed -- the settings
file byte-identical, the hook still wired at all three events, the off switch
untouched, and the hook expressing no permission opinion.

#### One state that was permanent in the worst way

`interlock-proof-missing` under a live binding -- a cleaned state directory, a
wiped temp tree -- used to be safe, silent and permanent at once: the runner held
automatic writes for ever (correct), while the **hook went inert for want of a
proof**, so the protection was gone and nothing would ever restore it. The
runner now voids the binding and writes a fresh proof with a fresh nonce, which
re-arms the hook; automatic writes stay held until the host observes it again.

This is the one automatic transition in the unit and it runs in the direction of
**more** protection, never less -- which is why it needs no manual gate. Only
`-missing` qualifies: a `-mismatch` means another writer owns that directory,
and overwriting its proof would be a fight rather than a repair. `#104 I14`

#### What is still only held, not denied

These hold **automatic writes** rather than tool calls, so they are not outages
in the same sense, but each is listed with its recovery because "held for ever"
is still a thing an operator has to be able to end.

`interlock-state-unreadable` used to be in this table and has been moved out: it
is **T11** above, a deny with no self-recovery that stops tool calls, not merely
a hold. It arrived here when it only held automatic writes and stayed after the
fix that made it deny.

| state | recovery |
|---|---|
| `interlock-hook-not-observed` | the seat's next turn (or next tool call) |
| `interlock-hook-missed-tool-calls` | the next tool call the hook *does* see -- forgiven on positive evidence, see leg 4 |
| `interlock-state-missing` | the hook's next invocation rewrites it |
| `interlock-state-stale` | the hook rewrites on a nonce mismatch |
| `interlock-proof-missing` | the runner re-arms, above |
| `interlock-hook-not-wired` | fix the settings; re-checked whenever the file changes |
| `interlock-hook-changed` | the hook file was replaced mid-session (an in-place upgrade). The proof is about a file that no longer exists, so this holds until a restart -- deliberate, and the restart is the recovery |
| `interlock-disabled` (`AIGENT_INTERLOCK=off`) | unset it; named on every tick |
| `runner-interlock-released` | **terminal for the binding, by design** -- the release's whole point |

### Exclusion can be lost, and that is a different enumeration

The enumeration in *No permanent tool outage* below runs in one direction only:
states in which the interlock **denies**. An independent review pointed out that
the opposite direction needed its own, because the states in which **exclusion
is lost** are the ones that produce a fail-open rather than an outage -- and one
of them is the same age clause that provides the deny table's only
self-recovery.

| state | what happened | now |
|---|---|---|
| **a gate stolen from a live, legitimate holder** | `stealable` takes a gate on **age alone** from a holder whose pid is alive and whose nonce matches. The comment claiming a legitimate holder could not reach `GATE_STALE_MS` was false: the clear's held span covers a `setImmediate`, a kill-switch read and a transport write; the capsule request's covers the ownership persist; and a forward wall-clock step reaches it unconditionally. Reproduced end to end with no injected errors and a +6 s clock step: the Enter went out with a live permission check recorded. | **detected, not prevented.** Both held-gate paths re-verify **on-disk token ownership** before writing, `commitClearSubmission` does the same instead of testing the in-memory handle, and the pending re-read now happens on both paths rather than being skipped on the held one. `releaseGate`'s boolean -- the one available "I lost ownership" signal -- is propagated and named. `#104 I16`, `I16b` |
| **a transient read error on the gate** | `gateHolder` returned `unreadable` for any errno outside a small set, and `stealable` treated that as free. One `EMFILE` on a host carrying 150 node processes stole a **live** gate, so both sides believed they owned the composer. This was the document's own substitution -- *cannot see, therefore nothing there* -- applied to the gate instead of the transcript. | **never stealable.** Cannot-say is not evidence of absence; the caller's bounded budget expires and `PreToolUse` denies. `#104 G2` |
| **a gate taken but not yet stamped** | `openSync(…, 'wx')` creates the file and the stamp follows immediately, so an empty gate is the ordinary state of one somebody has *just* taken. It read as `unparsed` and was stolen at once. | stealable only on the **file's own mtime**, which does not depend on the content being readable -- so a genuinely corrupt gate still recovers rather than wedging the session |
| **a release deleting someone else's gate** | `releaseGate` protected only the `held` kind against a foreign token, so every other kind fell through to the `unlinkSync`. | only a **positively confirmed own token** is unlinked |

**Why detection rather than prevention for the first row.** The age steal is the
gate's only self-recovery from a holder whose pid was recycled (row T4 of the
deny table), and no age bound survives a clock step, so removing it trades one
fail-open for a permanent outage. The honest move is to stop trusting the
in-memory handle: the invariant is a file another process can take, so it is
asked of the disk. Re-verifying is not "a second chance to be wrong" when the
thing being verified belongs to somebody else -- that phrase was in an earlier
draft of this document and it was wrong.

### Two more silent allows, closed

| state | was | now |
|---|---|---|
| `readStdin()` swallowed its error, or `session_id` was renamed or absent | `inert` → exit 0 → **the tool call proceeds with no marker**, silently. Reachable with no filesystem fault at all. | the event name now rides as an **argv** in all three template entries, independently of the payload, so a `PreToolUse` that cannot name its session **denies**. The clearing events stay inert: failing to clear only holds automatic writes. `#104 G24` |
| an unreadable `state.json` | replaced with `emptyState()`, so one `EBUSY` during another call's `PreToolUse` **destroyed a live marker with its dialog on screen**, reset the counters, and left all four legs passing and the runner reading ready. The invented state also carried `last_write_at: null`, so the same invocation skipped the drain. | `readState` already distinguished missing from unreadable; the hook now honours it. Only `missing` may be initialised; unreadable **denies** on `PreToolUse` and refuses to clobber on the clearing events. `#104 G15` -- which previously *blessed* this, using a fixture whose pending map had nothing to lose |

### And one dead branch, one memoised check

`interlock-pending-overflow` on the runner's side tested `> PENDING_MAX` while
the hook denies a new marker at `>= PENDING_MAX`, so the map could never exceed
the cap and the branch was unreachable -- a named state the runner could not
actually reach. It now tests `>=`.

The **wiring leg was memoised on success** for the whole binding, so unwiring
the hook mid-session was invisible until a successful interlocked clear happened
to re-bind -- and that is reachable by ordinary means, because the model holds
`Edit` on the project tree and `/hooks` rewrites the very file the leg reads.
The cache is now keyed on each candidate file's mtime and size, so a pass is
reused only while the files are the ones that produced it. Two narrower defects
in the same leg are fixed with it: the command must name **this** runner's
sibling hook rather than any file with that basename, and **one single settings
file** must wire all three events (the match used to accumulate across files, so
three different files could satisfy the three events -- which is not an install
that works). `#104 I19`

### Residual, after the interlock

Residual (1) and (3) from the list above are closed; (2) is narrowed, not
removed. What remains, stated as a fact rather than claimed away:

6. **The window before the hook has taken the gate.** The gate makes "the runner
   decided and wrote" atomic with respect to "the hook recorded a check". It
   cannot cover the interval between the host *deciding* to call a tool and the
   hook **process** reaching the gate -- a node spawn. In that interval neither
   mechanism can see the call: the hook has not marked it and the host may not
   have flushed the record either.

   This is a much smaller and much better-behaved window than residual (2)'s
   buffered flush: it is bounded by a local process start rather than by an
   unannounced flush of unknown duration, and it is bounded *below* the dialog,
   because the host does not render the permission prompt until the whole
   `PreToolUse` chain has returned. Two things still apply inside it: the
   delayed Enter re-reads inside its own gate 400 ms later, and the drain makes
   a hook that arrives just after a write wait out the bytes in flight.
   `#104 D20b` exercises it and asserts the write **does** go out -- the gap is
   in the suite as a fact.

7. **An inline sidechain tool call would be charged to the main session's
   counter.** Leg 4 counts every `tool_use` the reader parses, including an
   inline sidechain one. If a subagent's `PreToolUse` fires with a *different*
   `session_id`, `pre_runs` for this binding would not advance and automation
   would be held by name. Fail-closed and named, so not a safety hole; recorded
   because it is a liveness cost. On the measured binary (2.1.310) subagent
   records go to a separate `subagents/agent-*.jsonl` file and the bound
   transcript holds none of them, so this needs the inline shape `#79` had to
   exclude.

8. **A gate leaked by a hard kill is recovered on a timer, not instantly.** Every
   ordinary path releases the gate where it takes it, and `_abortPrepared`,
   `_disableAutomation`, the rebind and teardown all release it as a net. A
   `SIGKILL` inside the held span leaves it until a waiter finds the pid dead --
   immediate in practice, since the steal checks pid liveness first -- or until
   `GATE_STALE_MS`. The failure direction is denied tool calls, not permitted
   keystrokes.

9. **An exotic install that wires the hook somewhere the runner cannot read**
   (managed enterprise settings, for instance) reads as `interlock-hook-not-wired`
   and holds automation. `install.sh` renders the file the wiring leg checks, so
   a correct aigent-OS install always passes; a different layout fails closed
   and loudly rather than being assumed fine.

10. **A forward wall-clock step skips the drain**, and with a single clock the
    jump and the elapsed time are the same observation. The backward case is
    handled (it drains in full); this one is not fixable here. See *The drain*.

11. **The drain's own residual: the child being more than `INTERLOCK_DRAIN_MS`
    behind on reading stdin.** Unobservable from here and unbounded in
    principle. No supported mechanism proves consumption -- node-pty 1.1.0's
    `write` returns `void` and discards the socket's backpressure boolean -- so
    this is a mitigation with the proof obligation **undischarged**, not closed.

12. **`interlock-runner-gone` is a new *allow* path keyed on a pid.** A stale
    `proof.json` left by a dead runner makes the hook inert for that session id,
    so `--resume`ing that session **without** a runner runs unprotected until
    the directory is swept. That is sound on its own terms -- no runner means no
    automatic keystroke, so there is nothing to protect against -- and a runner
    that later binds to the same session id writes a fresh proof with its own
    live pid, which re-arms it. But it is an allow, it is automatic, and pid
    recycling can also make it read the other way. Named here because it is new
    surface, not because it is known to be wrong.

13. **Leg 4's forgiveness detects a DEAD hook, not a FLAKY one.** The
    shortfall is forgiven whenever `pre_runs` has advanced at all since the
    agreement point, so a **parallel-call batch in which one `PreToolUse` was
    missed** is forgiven as soon as any sibling was marked. The missed call is
    exactly the one whose dialog is up, and it is then covered only by the
    transcript leg -- the one measured absent for an entire dialog. Strictly
    better than the permanent deficit it replaced, and strictly weaker than
    catching it. The weakening is **flakiness, not staleness**: the advance is
    measured strictly since the last passing tick, the checkpoint lives in
    memory so it cannot be replayed from disk, and another session cannot touch
    it.

14. **The settled-id clearing depends on a bounded FIFO.** Markers whose
    `tool_use_id` the reader has seen settled are now really deleted from the
    file whenever the runner holds the gate, so this is a clearing rather than
    only a read-side discount. The *discount* still backs it, and that reads
    from a 512-entry FIFO which is dropped on re-baseline -- after which such a
    marker is held until a `Stop` sweep. Fail-closed, bounded by the turn.

## Verification

### Deterministic

`daemons/tests/pty-runner.test.mjs`, vectors `#104 D1`–`D44` plus `#104 M6`. 17 of the first 20
are red before the fix; `D1` is the first red and is the reported defect with
nothing else wrong (the vector asserts the composer is clean in setup, so the old
guard permits the write). `D21`, `D23` and `D24` are red against a *record*-scoped
anchor -- `D21` holds 1 outstanding call where it must hold 2, which is the
parallel-call fail-open -- and `D22` is green either way, because it pins the
liveness half the scoping must not break.

`D25` and `D26` are red against an anchor that admitted sidechain responses, both
reporting `ready: true` with a main-conversation call still outstanding: `D25`
that such a record cannot clear the set, `D26` that it cannot discharge an
unanchored baseline either. Each then asserts the liveness half -- a real answer,
and a real main-conversation anchor, still release -- so the exclusion is narrow.
`D27`–`D31` cover the oversize-record step, which had **zero** coverage before
this round -- nothing in `D1`–`D26` produced a record larger than one window, and
the `D10`/`D23`/`D26` fillers are 200 KiB lines, deliberately under it. `D27`
and `D28` are red against the unreset `responsesSeen` counter, `D31` against the
shared refusal name; `D29`/`D30` hold the two liveness directions.
`D32`–`D35` cover the operator-takeover rule, `D36`–`D38` the identity-space
tag.

Note that the suite could not have caught the sidechain anchor before:
`openToolCall()` omits `message.id`, so `D5`'s sidechain record was
anchor-neutral *by accident rather
than by rule*, and every response-scoped vector was written with
`isSidechain:false`.

#### The interlock's vectors

`#104 I1`-`I10` in `daemons/tests/pty-runner.test.mjs` (the runner's use of the
interlock) and `#104 G1`-`G17` in
`daemons/tests/pre-permission-interlock.test.mjs` (the mechanism itself).

The I series drives the **shipped hook function** in-process -- `runHook`, the
same entry point the hook's own `main()` calls -- against the **shipped runner**,
through the real files. Nothing is modelled.

**The whole D series now runs with a LIVE interlock**, which is why
`makeFixture` renders a `.claude/settings.json` in the fixture's project root
and the harness primes a `Stop`. Without that, every D vector would have become
a test of the held case. Two couplings were added to `openToolCall` /
`settleToolCall` and they are the honest shape rather than convenience: a
`tool_use` record means the host decided to call a tool, and on a wired seat
that decision ran `PreToolUse` first -- so the helpers run it, and
`hook: false` opts into modelling a seat whose hook has *stopped*, which is what
`I5` uses.

Red-before, against the **pre-#110-merge runner** (`git archive 80064d76`, the
runner `cmp`-verified byte-identical to `80064d76:daemons/pty-runner.mjs`, sha256
`a16ae63f…`, with only the new hook module and the new test files copied in):
**20 of 21** new/rewritten vectors red. The first red of each is in the PR
description. `I8` is green either way, deliberately -- it pins behaviour the
interlock must *not* change.

The red run needs one shim, and it is named in the harness: against a pre-fix
runner there is no `_ensureInterlockProof`, so nothing would write the proof the
hook keys on, the hook would be inert, and every I vector would fail on its own
*setup* rather than on the defect. The harness writes the proof itself in that
case, so the red result is "the runner could not see a permission check that was
recorded for it" -- the actual fail-open -- rather than "the fixture could not be
arranged".

`I10` could not be red that way, because it is about a path *inside* the new
mechanism. It was proved red against a **mutant** of the fixed tree with the
settled-id discount -- one line -- removed and the runner `cmp`-verified
identical to the shipped one: `0` Enters where `1` is required, and it is the
only semantic failure in that tree.

### Host evidence

`scratchpad/p104/driver2.cjs` -- bounded, isolated, cancel-only, never approves.
It runs a real `claude.exe` against an authenticated disposable profile with
`permissions.ask: ["Read"]`, and drives the **shipped** reader and the **shipped**
`_writeControlEnter` (methods borrowed from `ManagedPtyRunner.prototype`, so the
code under test is the code that ships) against the **live** transcript, with a
spy PTY so nothing can reach the child.

Run three times on binary **2.1.310**: `18:58Z` (session `a1b3a275`, against the
text-write and delayed-Enter guards), `19:56Z` (session `e8cd53af`, against the
response-scoped reader) and `21:07Z` (session `529aa897`, against the final
reader after the B1 and S2 fixes). The first two reported `ok: true`; **the third
reported `P1: false`, and that result is kept rather than re-rolled** -- see
below. Figures are from run 2 unless stated:

- **No automatic answer.** Three samples while a real dialog was on screen:
  `ready=false`, `runner-tool-call-outstanding`, outstanding id
  `Read:toolu_01SR8oPZs7…`. The shipped Enter boundary wrote **0** Enters,
  rescheduled once, and kept the stranded-text flag up.
- **Cancellation recovers.** ESC only. Within 1.5 s readiness returned and the
  boundary wrote exactly one Enter -- not wedged. The cancellation settled its
  own call (`Read`, `is_error: true`).
- **Ordinary success does not stick.** `Glob` (in `permissions.allow`, so no
  dialog at all) executed with `is_error: false`. The reader held the boundary
  across three consecutive samples while it ran, then released; three
  post-execution samples all ready, all writing. That is the signal working on a
  tool call with no dialog behind it at all -- it tracks the call's lifetime, not
  the dialog's.

**Run 3 and the negative result.** Same driver, same settings, final code. P2
and P3 passed. P1 reported **false**: all three samples taken while a real
dialog was on screen read `ready: true` with an empty outstanding set, and the
driver's *independent* parser agreed -- because the `tool_use` record was not yet
on disk (offset 286521, file 283263 bytes). The reader was not wrong about the
bytes; the bytes were not there. See residual (2), which this run is the evidence
for.

This is reported rather than re-run to a pass, because re-running until P1 goes
green would be selecting the observation that flatters the design. The honest
summary of the host evidence is: **on 3 of 4 observations of a real dialog the
signal was readable in time and the guard held; on 1 of 4 it was not, and the
guard would not have held.** The deterministic coverage is unaffected -- it
exercises the reader against transcripts that *do* contain the signal, which is
the half of the problem the reader owns.

Raw artifacts: `scratchpad/p104/run2/` (`driver2.log`, `samples.json`,
`screen.log`, `PROMPT.txt`, `CANCELLED.txt`) -- overwritten per run, so the
figures above are the durable record.

#### The interlock's host evidence

`scratchpad/p104b/driver3.cjs` -- same isolation, same authenticated disposable
profile (`CLAUDE_CONFIG_DIR` pointed at the existing `p104/cfg`; no credential
was copied and no live configuration was touched), same **cancel-only**
discipline: it never writes `
` while a dialog is up, and the only keys it
sends at a dialog are ESC and one measured `Ctrl-U`. It never approves anything,
and the scratch settings are *stricter* than the profile's (`ask: ["Read"]`).

What it drives is the **real hook, run by the real host** -- wired at
`PreToolUse`, `PostToolUse` and `Stop` in a project-level `.claude/settings.json`
in a trusted workspace, the shape `install.sh` renders -- plus the **shipped**
runner methods borrowed from `ManagedPtyRunner.prototype`, against a **real**
permission dialog, with a spy PTY so nothing reaches the child.

Run on binary **2.1.310**, `2026-10-25T17:22Z`, session `b6971e0a`:

- **The marker precedes the dialog.** Polled every 25 ms from the prompt's Enter
  onwards: 92 polls, of which **3 saw the marker with no dialog on screen** and
  **0 saw the dialog with no marker**. The marker led the dialog by **75 ms**.
  This is the measurement the whole mechanism depends on, and the earlier
  attempts at it were *not* this: polling at 120 ms, and only after a 4 s
  re-press window, produced a timeline with a single sample in which both were
  already up -- which could not resolve the ordering at all and was reported as
  unresolved rather than as a lead.
- **The interlock held on its own.** `_interlockReadiness` alone answered
  `ready: false` / `interlock-permission-pending` at **every** sample while the
  dialog was up. That is the leg that has to work when the transcript says
  nothing, and on this run the transcript *did* see the call (it was flushed in
  time), so the composed verdict named `runner-tool-call-outstanding` -- both
  refusals are correct, and the interlock-only number is what shows it would
  have held either way. **The unflushed case did not recur on this run** (0 of 3
  dialog samples had the call missing from disk); it is covered deterministically
  by `#104 I1`, which constructs exactly that state.
- **No automatic answer.** The shipped Enter boundary wrote **0** Enters,
  rescheduled once, and kept the stranded-text flag up, at every dialog sample.
- **The liveness proof is not decoration.** The sample taken *after* the runner
  wrote its proof but *before* the host had run the hook answered
  `ready: false` / `interlock-state-missing`. One turn later, with
  `stop_runs: 1`, it answered ready. An unobserved interlock holds, on a real
  host, by name.
- **`Ctrl-U` at a real dialog selected nothing.** The dialog was still on screen
  after it. #110's exemption is now measured rather than asserted.
- **Cancellation recovers with no further operator keystroke.** ESC only.
  Readiness returned at the first sample after the cancellation (~1.5 s after
  the ESC, which is the driver's own settle sleep, not a measured latency) and
  the boundary wrote exactly one Enter -- **with the marker still in the file**,
  because the transcript had settled its id. That is the clearing path that was
  added *because of* run 3's earlier failure, and this is it working.
- **An ordinary successful call does not stick.** `Glob` (in
  `permissions.allow`, so no dialog at all) left a marker while it ran and the
  marker was gone afterwards; three post-execution samples all ready, all
  writing.

Raw artifacts: `scratchpad/p104b/run3/` (`driver3.log`, `samples.json`,
`timeline.json`, `screen.log`, `PROMPT.txt`, `CTRL-U.txt`, `CANCELLED.txt`) --
overwritten per run, so the figures above are the durable record.

#### The run that changed the design

The **first** completed interlock run (`17:09Z`, session `ee986519`) is kept
here because it found a defect rather than confirming one. Its clearing paths
were `PostToolUse` for the id plus the turn's `Stop` sweep. **An ESC-cancelled
turn fired no `Stop` at all**: `stop_runs` stayed at 1 from before the dialog,
through the cancellation, and through the whole of the *next* turn's tool call,
reaching 2 only when that later turn ended. The marker was therefore held for
**48 s** (17:09:50 to 17:10:38) with no dialog on screen, and an operator who
walked away would have held automation indefinitely -- fail-closed, but the
exact recovery case this work exists to get right. That is what added the
settled-id clearing path and `#104 I10`. The run is reported rather than
discarded, for the same reason #110's P1 failure was.
