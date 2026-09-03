---
title: Two-Verb Lifecycle
tags: [doctrine, capsule, lifecycle, resume, session-management]
aliases: [two-verb, capsule verb, resume verb]
created: 2026-07-17
---

# Two-Verb Lifecycle

> [!note] v0.9.1: minimal model
> v0.9.1 ships the minimal two-verb model: `/resume` selects the **newest capsule by date**; the earlier beta's "stale/spent capsule" bug is designed out, not patched around. The nonce/receipt handshake, pointer bookkeeping, and polling cycle-driver from that beta are removed entirely; newest-by-date selection replaces the guarantee they existed to provide.

> [!abstract] Core idea
> Session continuity collapses to exactly two verbs: `/context-capsule` (write state, then stop) and `/resume` (load state, re-ground, act). `/open` and `/close` are retired: resume absorbs open, the capsule verb absorbs close. Both verbs also fire automatically at the right SessionStart/Stop hook points, so the operator rarely needs to invoke them by name.

This doc is the design reference for `skills/context-capsule/SKILL.md`, `skills/resume/SKILL.md`, and the daemons that implement them. Edit those files in lockstep with this one: this doc is the authored source; the skill files and daemon prompts are its runtime artifacts.

## Why two verbs, not four

The prior generation had four session-lifecycle skills: `/open` (load context), `/close` (commit memory), `/context-capsule` (checkpoint state), `/pause` (mid-session checkpoint). In practice `/open` and `/close` were always paired with a capsule write/read anyway; the capsule *was* the state that made open/close meaningful. Collapsing to two verbs removes the duplication:

- **`/context-capsule`** is the only way state gets written. It absorbs `/close`; there is no separate close ceremony, and no separate `/pause` either (a mid-session checkpoint is just an early capsule).
- **`/resume`** is the only way state gets loaded and acted on. It absorbs `/open`; there is no separate open ceremony.

Both verbs also run automatically, at the two points in a session's lifecycle where they matter most: `/resume`'s procedure fires on `SessionStart(clear)` via `daemons/resume-verb.mjs`, and a rolling, best-effort version of `/context-capsule`'s write runs on every `Stop` event via `daemons/stop-capsule-writer.mjs`. The explicit skill invocations exist for the cases automation doesn't cover: a deliberate mid-session checkpoint, a named-capsule resume, or a handoff.

## The capsule schema

Every capsule is a markdown file with YAML frontmatter. Four fields are REQUIRED and validated by `daemons/capsule-verb.mjs`'s `validateCapsuleText()`:

| Field | Meaning |
|---|---|
| `id` | Stable identifier, non-empty |
| `objective` | What this thread of work is about, non-empty |
| `waiting_on` | The resume contract: what a fresh session needs to act, non-empty, never bare YAML `null` |
| `next_valid_action` | The concrete next step, non-empty |

Plus `parent_capsule_id`, `status` (`active → resumed → resolved`, also `paused`/`abandoned`), `trigger`, `expires`, `tags`, `created_at`, and `resolved_at`. `resume_trigger` and `success_criteria` are optional, additional fields a skill may include when they add real signal.

Two mechanics the fields above imply: `created_at` is stamped at write time in ISO-8601 with offset (the selector orders by parsing it; a date-only stamp backdates to midnight UTC), and `active → resumed` is written by the resume runtime at load (`markCapsuleConsumed`), never by hand: a consumed capsule cannot be silently re-resumed.

The body carries seven `[REFERENCE ONLY]` sections behind HTML anchor comments (`<!-- swe:done -->` etc.) that `stop-capsule-writer.mjs` merges bullets into: `Done (don't redo)`, `Historical-Errors → Resolutions`, `Historical-Rejected-Approaches`, `Files-Read / Files-Modified`, `Operating-Facts`, `Pending-Gates`, `Claimed-Rows`. "Historical-" prefixes and latest-wins framing are deliberate: body content is a *reference snapshot*, never an active instruction queue. Treating it as one is exactly the trap `/resume`'s fences exist to prevent.

## The content gate

`daemons/capsule-content-gate.mjs` is a zero-dependency vocabulary shared by both enforcement points (`capsule-verb.mjs`'s validator and `stop-capsule-writer.mjs`'s classifier). It rejects two failure classes that non-empty checks alone miss:

- **Injection echo**: an `objective` that is actually a harness/supervisor instruction verbatim (`[supervisor-resume]`, `[refresh-cycle]`, `[auto-pull]`, an inbox marker, a loop-tick banner...). Non-null, but not the operator's real objective.
- **Ceremony action**: a `next_valid_action` that opens with resume-boot ceremony text ("re-read the active turn state...") instead of real content. Non-null, but tells a fresh session nothing it can act on.

Both patterns are START-ANCHORED: a capsule that legitimately *references* the ceremony mid-action ("On resume: comply with the supervisor-resume instruction, then...") passes; only text that *is* the injection/ceremony fails.

## Validation

`daemons/capsule-verb.mjs` exports `validateCapsuleText()`: the one place required-field presence and the content gate (above) are checked together. It returns `{ fields, problems }`; an empty `problems` array means the four required fields are present and neither `objective` nor `next_valid_action` is injection-echo or ceremony-action. The Stop-hook writer calls it on the final merged autosave before committing the file. That check is diagnostic and fail-open because a Stop hook must still preserve the best available snapshot if validation cannot run. There is no separate trusted-writer process that stamps a pointer or a digest, and `validateCapsuleText()` remains available for a skill or test to self-check.

## Selection is loud about what it discards

`selectCapsule()` (in `daemons/lifecycle-common.mjs`) returns `{ capsule, rejected, unavailable }`. `capsule` is the winner; `rejected` is a ledger of every candidate it skipped and why; `unavailable` names the reason there is no winner (`no-capsules-dir`, `no-capsules-on-disk`, `all-candidates-rejected`, `capsules-dir-unreadable`, `bad-memory-root`). `newestValidCapsule()` stays as the thin wrapper for callers that only want the selection.

The ledger exists because of a specific failure shape. Every discard used to be a bare `continue`, so a capsule the selector threw away and a capsule that never existed produced byte-identical output: an empty resume that looked entirely normal. A matcher defect in that design can reject every capsule on disk indefinitely and never announce itself, because the only observable is silence, and silence is also what a clean fresh install looks like.

`daemons/resume-verb.mjs` prints the ledger into the injected procedure under `CAPSULES NOT SELECTED`, grouped by reason with counts, so a systemic defect reads as one line (`47x missing-required-field (next_valid_action)`) instead of 47 unrelated ones. Rejections labelled `already-consumed` are ordinary history, the previous cycle spending its capsule on purpose; every other reason is called out separately as a capsule that was authored and then discarded, which is a defect until proven otherwise.

The selectable state is `active` and nothing else. Two checks enforce that, and they answer different questions: the first separates capsules a previous resume already spent (`already-consumed`, ordinary history) from junk, and the second rejects every other status, including one that is merely unrecognized or absent. A draft, a typo, or a fork's own vocabulary is not resumable, and the ledger says which it was.

Covered by `daemons/tests/resume-verb.test.mjs`, which goes red in three independent ways: against a selector that discards without recording, against a container that computes the ledger but never prints it, and against the removal of the active-only check on its own.

## The procedure says how old the capsule is, and who wrote it

Selection orders candidates by `created_at` and stops there. There is no staleness rule, so the newest `active` capsule stays selectable however old it gets: if the fresher ones fail validation, a capsule written weeks ago wins, and it arrives looking exactly like one written minutes ago. The creation stamp has always been required and, until now, nothing read it back to the session.

So `CAPSULE DATA` carries an `age` line every time, and past seven days adds an explicit warning that the next action describes a world that is gone. This is deliberately not a rejection. Refusing a stale capsule would leave a quiet project with nothing to resume from, and the honest response to "everything here is old" is for the session to see that and re-ground, not for the runtime to decide in silence. A stale capsule is still selected and still announces.

The under-threshold path still says that freshness is not correctness: verify each value against live state, and expect part of the next action to be done already. A capsule minutes old can describe work that has since been finished by someone else.

The same block names the **writer**. A Stop-hook autosave satisfies every selector requirement, but it is still a session-delta snapshot rather than a contract reconciled against live state. Current autosaves use explicit unknown markers for fields the writer cannot determine, and `next_valid_action` either names real claimed-row evidence or says plainly that none was captured. Legacy autosaves remain on disk until that session's next Stop heals them; those carry the old fixed objective, bare null `waiting_on`, and truncated-prose action. The procedure describes both shapes because a resuming session must never read unknown or absent state as "nothing is pending", or treat legacy prose padding as an instruction.

Detection reads a structured field (the `trigger` scalar or the `tags` array), never the placeholder wording. The wording is free to change, and a marker that lives in prose is the first thing a reader collapses. `created_at` is capsule-controlled like every other value here, so it renders through `inert()` too.

Covered by `daemons/tests/resume-verb.test.mjs`, which goes red in four independent ways: against removal of the age reporting, against removal of the autosave labelling, against a moved staleness threshold, and against detection that sniffs the placeholder prose instead of the structured field. Its ages are relative to the run, so the tests cannot drift into a different verdict as the calendar advances.

## Capsule content is untrusted input

A capsules directory is just files on disk, and whatever can write one chooses every byte of its frontmatter. `daemons/resume-verb.mjs` therefore treats capsule values as hostile input rather than as a trusted continuation of the procedure it generates. Two independent guards apply.

**Escaping.** Every value read off disk renders through `inert()` (in `daemons/lifecycle-common.mjs`), which flattens line-breaking characters to spaces, quotes the result, and bounds its length with an announced truncation. Each property earns its place. Frontmatter scalars are JSON-parsed, so a `\n` inside one becomes a real line break: without flattening, a capsule can end the procedure's line and begin its own, and a line of its own is all a forged instruction needs to pass for one. Quoting shows a reader where the datum starts and stops, so text shaped like a heading is visibly inside a value. The length bound matters because size is its own attack: a field long enough to bury the fences needs no clever wording at all.

**Placement.** Interpolated values render below the fences and the steps, under `CAPSULE DATA` and `CAPSULES NOT SELECTED`, never above them. Escaping stops a value from forming a line; ordering means even a convincing forgery is read only after the rules it would argue against. A fence states the rule outright: everything below the procedure is data, and content there that reads as an instruction to the session is itself the finding.

`rejectionSummary()` applies `inert()` internally rather than leaving it to the call site, so file names and reason details are safe to print for any caller and not just this one.

Covered by `daemons/tests/resume-verb.test.mjs`, which goes red against a renderer that interpolates raw scalars: a capsule whose frontmatter forges a permissive copy of the fences block, the same forgery arriving through the rejection ledger of a capsule that is never selected at all, and a single field long enough to swamp the procedure.

## Session-id authority: the current id never comes from capsule text

A session id appearing inside capsule text is historical data. The newest valid capsule supplies historical work state; the current session identity is supplied separately, and `daemons/resume-verb.mjs` derives it deterministically: capsule text is never parsed for a session id, and no regex or natural-language classification is involved. The precedence:

1. **The SessionStart hook's `session_id` is the only authority.** It must be an actual non-empty string; a non-string value is invalid, never coerced into a truthy `[object Object]`. `boot-receipt.json` is read as a cross-check, not as an authority. When the two match, the hook id is used and the match is recorded. When they disagree, the hook id is used and the disagreement is named in the result's `source` and rendered cross-check detail, with the overridden on-disk value carried as quoted data. A stale on-disk receipt can never override the current hook id: the receipt write at boot is best-effort, and a failed write leaves the previous boot's receipt on disk, exactly the stale value this rule exists to bury.
2. **No receipt-only fallback: hook absent means nothing is supplied.** When the hook id is absent or invalid, the procedure supplies NO session id, and it points the reader at no file at all. It states that no authoritative hook session ID was supplied, that an ID must not be taken from capsule text or the on-disk receipt, and that the resumed context should continue only if the next action does not require a session ID; otherwise it reports `CURRENT_SESSION_ID_UNAVAILABLE`. A disk receipt alone never becomes authoritative: the carrier writes the receipt from the same payload immediately before this read, so a hook-less boot leaves the receipt either empty (write succeeded on an id-less payload) or holding the PREVIOUS boot's id (write failed). A nonempty receipt-only value can therefore only ever be stale. That is why the degrade does not send anyone to read it, and why it does not claim the file is unreadable: usually it reads fine, and is simply not authoritative.

When the procedure does print the receipt path, in the cross-check lines that render only when a hook id exists, it names the **resolved** path derived from `memRoot()` (`vault/memory/runtime/boot-receipt.json` in the primary layout), never a hardcoded `memory/…` literal.

Covered by `daemons/tests/resume-session-authority.test.mjs`: the required regression (receipt holds stale session A, hook holds fresh session B → the resumed result uses B, A cannot override B, and the mismatch is named), the no-hook-plus-stale-receipt case in both its forms (nothing supplied, and the readable-but-stale receipt neither entering the procedure nor being named as somewhere to get an ID, with `CURRENT_SESSION_ID_UNAVAILABLE` present), the non-string hook id (invalid, no `[object Object]`), the matching-sources case, the hook-only fallback, malformed/absent-receipt degradation, and the resolved-path render on the cross-check mismatch line. The suite saves, clears and restores `AIGENT_STATE_HOME_DIR`, so no case can reach a real seat vault through `memRoot()`'s diversion lever.

## Pluggable coordination: multi-agent guard

If a fork wires multiple agents/sessions that need to pause for a conducted, multi-party lifecycle event (a coordinated clear across several concurrent sessions, for example), point `AIGENT_COORDINATION_STATE` at a JSON file carrying a `phase` field. While `phase` is non-terminal (anything other than `done`/`cancelled`/`closed`/`complete`/`aborted`), `sessionstart-reinject.mjs` defers to the external conductor instead of running its own warm-start orientation or resume-verb procedure; this guard is checked before the `source==='clear'` branch, so a live coordinator wins even across a clear. Unset by default: a single-operator install never touches this seam.

## Declared lifecycle extension

An install supervised by an outside process usually needs the two verbs to announce completion in that process's own protocol. Without a seam the only way to carry that is a forked copy of `skills/resume/SKILL.md` or `skills/context-capsule/SKILL.md`, which the installer then treats as drift and quarantines, so the next clear never announces and the supervisor holds the seat forever. The seam turns that handshake into a declaration the install owns.

Copy `daemons/lifecycle-extension.example.json` to `<target>/.aigent/lifecycle-extension.json` and edit it:

```json
{
  "schema": "LifecycleExtension/v1",
  "resume_ack": "As the final action, notify the supervising process with this exact body: EXAMPLE-PROTOCOL resumed {capsule_id}",
  "capsule_ack": "Before the completion literal, notify the supervising process with this exact body: EXAMPLE-PROTOCOL capsule-written {capsule_id}"
}
```

Both fields are optional. Each is one line, at most 500 characters, free of control characters, and may use `{capsule_id}` at most once. `.aigent/` sits outside every installer-managed tree, so the declaration survives an install and an update without needing an entry in `.aigent/operator-owned.json`.

What runs where:

- **Resume.** `daemons/lifecycle-extension.mjs` resolves `resume_ack` against the loaded capsule id, and `daemons/resume-verb.mjs` renders it as step 5 of the injected procedure, after the core acknowledgement. A template carrying `{capsule_id}` renders nothing when no capsule was loaded, so a degraded resume can never invite a fabricated id.
- **Capsule.** `capsule_ack` runs as step 6 of the capsule skill, rendered by `node daemons/lifecycle-extension.mjs render capsule_ack --capsule-id <id> --root <target>` which always exits 0, after all core work and immediately before the terminal literal. This one is deliberately not last. The literal is the acknowledgement the supervising machinery watches for, and the clear is gated on that acknowledgement and on nothing after it, so once the literal is observed the clear can be minted straight away, mid-turn. A step placed after the literal runs in a window the core already treats as closed and races the clear it is meant to precede.

An install that declares nothing runs the unmodified standalone lifecycle, and nothing about either verb changes.

Failure is fail-open and loud. An unreadable, malformed, or invalid declaration is refused whole, both fields go null, and the procedure carries one line beginning `LIFECYCLE-EXTENSION: declaration ignored:` naming the path and the reason. The same line goes to the daemon error log. This is the opposite of the namespace registry's fail-closed `process.exit(1)`, and the difference is deliberate: that registry gates indexing, where refusing to run is safe, while this gates session start, where refusing to run wedges every clear on the seat. A partial declaration is never salvaged, because a half-armed handshake looks exactly like a working one.

The declaration is data, never code. Nothing loads a module or spawns a process, and core never learns any particular supervisor's vocabulary. Both surfaces read it through the same loader: resume via `daemons/resume-verb.mjs`, capsule via `node daemons/lifecycle-extension.mjs render capsule_ack`, so a declaration refused on one surface is refused on the other by the same validator. The declared text is a protocol body the seat is told to send verbatim, so it is NOT rendered through `inert()`, which quotes and escapes: it goes through a non-quoting single-line fold shared by both surfaces, and reaches the seat byte for byte with the id substituted. What the fold still guarantees is the property that matters, which is that a declared value can never own a line of its own; the loader independently refuses a multi-line, over-long or control-character field, and the rendered step sits below the core steps where it could not suspend one anyway. Length is measured on the SUBSTITUTED string, charging `{capsule_id}` a fixed id budget, so an accepted declaration can never render truncated.

## Context-pressure self-refresh (retired in v0.9.1)

`daemons/ctx-refresh-sensor.mjs` is now a compatibility stub (`process.exit(0)`): the 60%/75% self-refresh reflex, the `CAPSULE_VERB_AUTOFIRE` autofire path, and the request-gated refresh cycle it depended on (`refresh-request.mjs`, `refresh-cycle.mjs`, `refresh-cursor.mjs`) are removed along with the rest of the tower. The file is kept only because an existing `settings.json` may still name it as a `PreToolUse` hook; it does nothing when invoked. `daemons/statusline-ctx.sh` still writes `~/.claude/ctx-refresh/<session-id>.json`; nothing in the box currently reads that file, but a fork is free to re-wire its own sensor against it.

## Operator sovereignty (never violate)

- **The capsule is best-effort autosave, never a gate.** An operator `/clear` passes through whether or not a capsule landed. Nothing in this system should ever tell the operator to wait on capsule machinery.

## Former refresh-cycle issue

The v0.9.0 beta's known issue (an automated refresh cycle could try to stamp a fresh, still-`waiting_on: null` autosave capsule and be refused) no longer applies: v0.9.1 removes that stamping path entirely (see "Context-pressure self-refresh" above). `validateCapsuleText()` still treats a bare `waiting_on: null` as not resumable, and the Stop writer now calls it diagnostically on every final autosave. Validation problems are logged but never block the snapshot. Current autosaves emit an explicit unknown marker instead of null, while legacy autosaves heal on their next write.

## File map

| File | Role |
|---|---|
| `daemons/lifecycle-common.mjs` | Shared identity/vault resolution, `selectCapsule()` selection plus its rejection ledger, `inert()` value rendering |
| `daemons/capsule-content-gate.mjs` | Injection-echo / ceremony-action vocabulary |
| `daemons/capsule-verb.mjs` | `validateCapsuleText()`: required fields + content gate |
| `daemons/curated-close-pointer.mjs` | Compatibility pointer writer (audit/orientation hint only, resume never reads it) |
| `daemons/resume-verb.mjs` | Resume verb container: SessionStart(clear) hook |
| `daemons/lifecycle-extension.mjs` | Optional declared lifecycle extension: loader and validator, fail-open |
| `daemons/lifecycle-extension.example.json` | Template to copy to `<target>/.aigent/lifecycle-extension.json` |
| `daemons/sessionstart-reinject.mjs` | Warm-start reinject + resume-verb carrier: SessionStart(all sources) hook |
| `daemons/stop-capsule-writer.mjs` | Every-turn rolling capsule delta writer: Stop hook |
| `daemons/ctx-refresh-sensor.mjs` | Compatibility stub (PreToolUse): self-refresh reflex retired |
| `daemons/statusline-ctx.sh` | Context-percentage writer (currently unread by anything in the box) |
| `skills/context-capsule/SKILL.md` | The capsule verb, explicit invocation |
| `skills/resume/SKILL.md` | The resume verb, explicit invocation |

## A note on the merged SessionStart hook

The source system this was ported from ran two separate SessionStart scripts because it coordinated several concurrent agent identities, each with its own hook-matcher wiring quirks. aigent-OS is single-operator, so `sessionstart-reinject.mjs` handles every source (`startup`, `resume`, `clear`, `compact`) in one file; there's no per-agent matcher split to preserve. If a fork later adds genuine multi-identity support, re-splitting by source is a reasonable place to start, but nothing in the current architecture requires it.
