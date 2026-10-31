# Procedure experiment fixture

This proves mechanics on a fixture, not natural-language procedure compliance, live resume behavior, or prevention of future incidents. No model runs and no installed procedure is promoted. The adapter allocates a temporary root and uses the existing Finding producer and meta gate there.

Step 2 has this grammar (one line, exact keywords and spacing):

```text
2. collect scope=<selected|local|all> resolve=<writer|any|none> match=<fields> where=<*|JSON string>
```

`fields` is any nonempty ordered subset of `op,kind,target`, without duplicates. `selected` collects from the selected capsule in the current scope, `local` from every capsule in that scope, and `all` from every supplied scope. Resolution always searches the current scope: `writer` admits writer-owned terminal rows, `any` admits every terminal row, and `none` disables resolution. A terminal row has outcome `confirmed` or `failed`. Identity uses the declared fields, with a leading `sidechain:` removed from kind. Requested and unknown rows survive unless resolved; `where` optionally filters their operation id. Output is distinct sorted ids. Every grammatical combination executes. Wrong results fail, and unparseable procedures produce UNKNOWN. The remaining procedure text is fixed.

The held-out source is an earlier decision-table test, vendored byte-for-byte as `decision-table-source.txt` (9,526 bytes). Its Git blob is `d5c1e98e609ad712d13ef6768581f148df6b3bc0`. `corpus.mjs` reads those bytes relative to its own module, checks the Git blob hash, and projects the source test decision rows without importing or executing that test. Evaluation needs neither Git nor a particular branch or working directory. The historical source, its provenance, and the derived corpus are frozen before evaluation. No candidate argument is passed to the derivation.

| Historical row | Projection and expected decision |
|---|---|
| 1 | Selected unresolved operation remains visible |
| 2 | Each of six capsule statuses retains its requested or unknown operation |
| 3 | Writer-owned confirmed and failed identities remove carried operations |
| 4 | Curated rows, partial ownership and prose cannot resolve an operation |
| 5 | Different kind or target does not resolve the original identity |
| 6 | Curated unresolved rows remain visible |
| 8 | Foreign scopes contribute neither unresolved operations nor resolutions |
| 10 | Resolved-only history leaves unresolved output empty |

These are 13 held-out projections plus the separate sanitized origin. The held-out expectations were projected by hand from those rows. About 7 of the 13 share the origin's structure (the six status variants of row 2 and row 6); cases 3, 4, 5, 8 and 10 are the independent signal, numbered by their source rows. The origin is training evidence. Historical rendering, second-session presentation, malformed-input diagnostics, and truncation behavior are not measured by this unresolved-id projection. Any new synthetic scenario belongs outside held-out. The tests exercise additional grammar combinations against the frozen cases; they do not create additional held-out claims.

The candidate, exact base and delta, evidence, corpus, size budgets and rollback are pinned before one paired evaluation. Size limits cover procedure bytes, corpus bytes, positive growth and case count. Timestamps are audit metadata only; wall-clock time never affects a verdict. Valid overfit and unrelated-regression candidates fail their result assertions. A valid candidate carrying instruction-like source evidence executes normally but is rejected because its source references do not match admitted evidence. Evidence text is never executed or treated as approval.

Approval is a caller-supplied record with `decision: "approve-fixture"`, an actor, exact candidate id/hash, base hash, and review evidence. Equal author/approver or author/evaluator strings refuse. Distinct identity strings are not authenticated review. The deterministic evaluator and caller record do not establish independent human review or real operator authorization. Instrument and adapter hashes are checked after freeze, with refusal tests that modify temporary module copies.

Promotion writes the tested procedure before the application record, then reads the persisted bytes to recompute unrelated-region hashes. Function replacers preserve literal dollar sequences. An application-record write failure can leave the tested procedure applied; the pre-recorded rollback restores it. Integrity enforcement is limited to one sequential process, not hostile concurrent writers or restart recovery.

Run only `node --test daemons/tests/procedure-experiment.test.mjs` from the repository root, or `node --test ../daemons/tests/procedure-experiment.test.mjs` from `evals/`. Its ten tests cover these fixture mechanics. Reports are written only beneath a temporary fixture root and removed during cleanup; there is no tracked result packet.
