---
name: nightly-ledger-capture
agent: none
description: Discovers missing honesty, trust-decay, failure-mode, and decision-outcome entries from local evidence; stages judgment and permits direct mutation only after an executable oracle.
allowed-tools: Read, Write, Bash
user-invocable: true
status: PRODUCTION - stage first and never self-confirm
triggers:
  - nightly ledger capture
  - stage measurement candidates
  - ledger capture
---

# /nightly-ledger-capture

This is Leg F's capture protocol. It keeps human judgment human-gated while
making mechanical claims reproducible.

## Local sources

Read:

- today's valid capsules by frontmatter `created_at`;
- canonical dated Session Log blocks;
- explicitly referenced local Git commits and diffs;
- current `HONESTY_LEDGER.md`, `TRUST_DECAY.md`, and `FAILURE_MODES.md`;
- `DECISION_LOG.md` and `DECISION_OUTCOMES.md`.

These sources discover claims. An agent-authored capsule or log entry cannot
verify its own claim. The implementation has no dependency on an external
coordination service and reports its source scope as local memory plus Git.

## Candidate predicates

### Honesty

Stage when the day contains consequential multi-file work, a large change, a
verified/shipped/deployed/merged claim tied to an artifact, or an uncaptured
tradeoff/cost/stopped-short statement. Honesty classification requires
judgment, so it is always staged.

### Trust decay

Stage the one to three most consequential confident claims only when
consequential work is also present. Capture the exact claim, claimant, source
reference, and proposed executable resolution predicate. Later narration is
not a resolution oracle.

### Failure mode

Stage when a diagnosis contains a verified cause plus a real red-before and
green-after receipt and the class is not already represented.

### Decision outcome

An exact operator answer has already crossed its human gate. Direct append is
legal only when all are true:

1. exact authored text is `HELD | DRIFTED | REVERSED | STILL UNCLEAR`;
2. decision date and exact heading uniquely match one decision;
3. interval is exactly 30, 60, or 90 days and is due inside the documented
   tolerance;
4. the interval is absent from the matching outcome entry; and
5. the pre-write SHA-256 still matches.

Invoke:

```text
node daemons/nightly-decision-outcome.mjs --root <aigent-root> \
  --as-of <YYYY-MM-DD> --decision-date <YYYY-MM-DD> \
  --decision-title "<exact heading>" --interval <30|60|90> \
  --outcome "<enum>" --operator-text "<exact enum>" \
  --operator-source "<durable direct operator ref>" \
  --expected-file-sha "<pre-read sha256>"
```

The writer compare-and-swaps, appends one check, verifies it, and dedupes
replay. Ambiguity remains staged.

## Staging product

Append through the sole writer to:

`vault/memory/runtime/NIGHTLY_CAPTURE_CANDIDATES.jsonl`

```text
node daemons/nightly-ledger-stage.mjs --root <aigent-root> \
  --date <YYYY-MM-DD> --candidate-json '<serialized object>'
```

Candidate fields:

```json
{
  "candidate_id": "nc-YYYYMMDD-NN",
  "ledger": "honesty|trust_decay|failure_modes|decision_outcomes",
  "claim": "...",
  "source_refs": ["..."],
  "evidence_class": "judgment|mechanical",
  "predicate_proposal": {
    "type": "file_sha256_equals|json_field_equals|git_commit_present",
    "args": {},
    "expected": "..."
  },
  "predicate_receipt": null,
  "status": "staged",
  "created_at": "ISO"
}
```

The writer allocates max suffix plus one, hashes normalized content for
dedupe, forces `status=staged`, serializes JSON, and re-parses the complete
file. Mechanical evidence requires a current green receipt; judgment may carry
only a proposed predicate.

## Direct mutation predicate

### Local hash-comparison Finding (Stage 1)

Opt in on the existing predicate evaluator:

```text
node daemons/nightly-ledger-predicate.mjs --root <aigent-root> \
  --type file_sha256_equals --path <relative-artifact> \
  --expected <independently-pinned-sha256> --finding
```

The evaluator compares file bytes with the caller's pinned expectation. Source
bytes are never parsed as instructions, verdicts, targets, receipts, or authority.
The ordinary invocation remains read-only. A healthy comparison emits no Finding.
A readable mismatch emits `FAIL`; absent, unreadable, escaping, or malformed
evidence emits `UNKNOWN` with a HOLD statement. Both remain observations. A hash
mismatch alone does not establish a product defect or a verified cause.

The existing `stageLedgerCandidate` append path stores one `trust_decay` row in
`NIGHTLY_CAPTURE_CANDIDATES.jsonl` under the resolved runtime directory. It reuses
`candidate_id`, `created_at`, `claim`, `source_refs`, `status=staged`, and
`dedupe_key`. A producer-owned `finding` extension supplies:

- `producer`, `product.name`, Node version, and exact SHA-256 identities of the
  evaluator, writer, and their local dependency files;
- `subject` and `subject_root`, which anchor relative artifact references;
- `state`, the embedded evaluator `receipt`, `scope`, and `exclusions`.

`receipt:sha256=<hash>` resolves to the embedded `finding.receipt` using the
existing `receiptHash` function. A resolved file also retains the evaluator's
`file:<path>#sha256=<hash>` reference. The receipt records the observation time,
expected hash, measured hash, and exit status. Hashes identify evidence; they are
not signatures. Runtime observations are local data, not authorized instructions.

Sequential replay of the same product, subject, expectation, and measured outcome
returns the original row, including its original observation time. Time changes
alone do not add counts. Changed outcomes or producer bytes get distinct identities.
This retains the existing single-writer scope; concurrent writers are not supported.
Healthy later runs do not erase, resolve, or promote historical observations.

The row stays `evidence_class=judgment` with no resolution predicate. Its measured
comparison is factual, but interpreting it still requires judgment. Existing
mechanical candidates continue to require a reproduced green receipt. Candidate
JSON cannot supply `finding` metadata; only a fresh evaluator execution can.
There is no hook activation, external write, rule change, or model call.

Archaeology: `FAILURE_MODES.md` requires a verified cause; eval rows carry
pass/fail/unrunnable but lack this append path; nightly alerts carry active/resolved
delivery state rather than staged observations. The existing staged row and writer
therefore remain the smallest fit. The extension is necessary because that row
lacks producer identity, subject, scope/exclusions, and a place for red or UNKNOWN
receipts without weakening its green-only mechanical evidence gate. Unpublished
eval-runner and eval-integrity work was inspected; neither provided Finding intake.

Focused proof: `node --test daemons/tests/ledger-finding.test.mjs`. Before the
implementation, the real producer printed `LEDGER_PREDICATE FAIL`, exit 1,
observed `d22a79fb39b2e7e5c57bec3f10eaf6e61f67233613a9191d38963886401b1222`;
the new assertion failed with `0 !== 1` Findings (0 passed, 3 failed). The sanitized
control changes only the bytes `safeguard enabled` to `safeguard disabled`. It is a
controlled mismatch, not evidence of a deployed defect. Tests cover replay, a
healthy control, UNKNOWN, inert forged payloads, and the unchanged green-only gate.

Future adapter, read-only proposal: `findingToObligation` would first check
evidence admissibility, confidence, and duplicates before existing `boardCreate`
and transition fences. UNKNOWN, refuted, duplicate, or insufficient observations
must create no work. No adapter or organizational write is implemented here.

### Existing direct mutation gate

Direct ledger mutation is legal only when:

1. `daemons/nightly-ledger-predicate.mjs` executed it;
2. type is `file_sha256_equals`, `json_field_equals`, or
   `git_commit_present`;
3. arguments are structured data rooted inside the selected root, never shell
   text;
4. receipt hash, observed result, literal exit, and expected result match;
5. the artifact is external to the claim narration and directly decides it;
6. mutation delegates to the existing canonical ledger owner and embeds the
   receipt.

Otherwise stage. Never flip a prose resolution based on self-confirmation.

After capture, run `daemons/nightly-ledger-review.mjs`. Its literal
`FRIDAY_MEASUREMENT` receipt reports the weekly counts without applying any
judgment-bearing proposal.

Return:

```text
LEDGER_CAPTURE PASS staged=<N> direct=<N> duplicates=<N> sources=local-memory,git
```
