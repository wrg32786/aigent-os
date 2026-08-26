# PREREG-001-COMPUTED: frozen Phase B artifact identities

Preregistration: `recollection-44/PREREG-001`.
Packet sha256: `6a45b8992492bf947e5abc6fcd079d63530c1ab4015a28eee29dcc8c0be252c4`
(verified at this hand as the sha256 of `PREREG-001.md` with its last line
excluded and CRLF normalized to LF; the file on disk is CRLF).

Written: 2026-08-26, **before any query was run**. PREREG-001 1.5 requires
these values to be computed and recorded the same session the corpus is
committed and before the first query. Nothing in this file was chosen with
knowledge of a measurement.

PREREG-001 section 9 residue item 1 named `corpus_sha256`, `overlay_sha256` and
`fixture_registry_sha256` UNKNOWN because the fixture did not exist at commit
cdb7022. This file closes exactly those three unknowns, plus residue items 3
(model weight identity) and 6 (execution environment). It changes no case,
count, threshold, budget or definition.

## Fixture hashes, by the rule frozen in PREREG-001 1.5

Rule, restated from the packet: enumerate every regular file recursively;
exclude nothing by extension, but explicitly exclude `memory/embeddings.json`
if present; convert every path to a corpus-root-relative POSIX path; sort the
path list by raw UTF-8 byte order (C collation, not locale collation); for each
path in that order feed one sha256 accumulator the path bytes, `0x00`, the
decimal byte length of the file as ASCII, `0x00`, the file bytes, `0x0a`.

```text
corpus_sha256            8e5e0d8f977511d45afe14eb04351ef5fe6854172fa2075ce1e92d73e6529b0d
                         over evals/recollection/corpus/ (116 notes)
overlay_sha256           3ef987498e74ac226e75f75a6391b66a1046c3249bdb866f734755c7e443a560
                         over evals/recollection/overlays/undeclared-namespace/ (2 notes)
fixture_registry_sha256  2a11e724508b755d0b6a237f4b3e65ba8b6421c744e019905b67f00759912b96
                         over evals/recollection/fixture-registry/ (2 files)
```

The runner recomputes all three at the start of every run and refuses to score
anything if a value differs from the value above. A corpus edit after the first
run is a new corpus identity, not a re-run.

## Corpus composition, as committed

```text
namespace              disposition  declared by         notes
daily                  INDEX        core registry        10
memory                 INDEX        core registry        10
concepts               INDEX        core registry        10
projects               INDEX        core registry        10   (4 under
                                                               projects/confidential-client/,
                                                               denied by prefix)
people                 INDEX        core registry        10
agents                 INDEX        core registry        10
research               INDEX        core registry        10
feedback               INDEX        core registry        10
reference              INDEX        core registry        10
templates              SKIP         core registry         6
examples               SKIP         core registry         6
ops-index              INDEX        fixture local reg     6
ops-skip               SKIP         fixture local reg     4
ops-deny               DENY         fixture local reg     4
                                                        ---
                                                        116
```

Sixteen of those INDEX notes form the eight temporal pairs: three pairs in
`memory`, two in `projects`, three in `reference`. Each temporal note carries a
body line of the exact form `Valid from YYYY-MM-DD` or
`Valid from YYYY-MM-DD to YYYY-MM-DD`, in the BODY and not only in
frontmatter, because `embed-vault.js:294` stores a slice of the raw body and a
frontmatter-only date could never appear in a returned chunk.

The PC-01 canary token `ZEPHYRLOCK-8829-QUARTZWEAVE` appears in exactly one
note, `reference/tuning-fork-calibration-log.md`, and in no other note.

## Benchmark artifact identities, as committed

```text
corpus/fixtures/cases/runner first committed at
                         ff522ac6f0e187707b3ba33a0d87feeb66c54dca
tree                     52985f1ce651968104702fba5c0f759995a17faa
branch                   titus/44-phase-b

evals/recollection/cases/queries.json
  sha256                 2012f0523333498e33c6350e1c289357742ff1689f733ff55411377e765a037f

evals/recollection/cases/stale-index.json
  sha256                 41fef6cfaf355d3eab09bc97a22916b16c36afc2995237cee8f3ab75d759b980
```

### Instrument identity for the reported runs

The corpus, the overlay, the fixture registry and the query population are
frozen and were never edited after the three hashes above were computed. The
RUNNER is the instrument, not the fixture, and it was corrected three times
before the reported sequence was executed. Every reported run in
`results/` was produced by the single version below.

```text
evals/recollection/run-recollection.mjs   (final, used for every reported run)
  sha256                 2c0fc5e119646598325074e505b1e2e76085bbb9b91b44e7eae49fe386cda1cb
  committed at           9ba01260bb083996ca3222be1c0d596834bf731b
```

The three corrections, each moving an assertion toward the packet's wording and
none of them touching a threshold, `tau`, K, a class count, a corpus byte or a
query:

1. `74a6aacf` — load-time loudness was scanning the whole of stdout for the
   offending path. `search-vault.js` prints a `Path:` line for every returned
   row, and a carried-forward dangling row (`embed-vault.js:253-257`) IS
   returned, so the defect L-01/L-02 exist to catch was being scored as
   evidence of its own absence. Rescoped to the population-load window that
   PREREG-001 3.7 actually names.
2. `9ba01260` — the F4 mutation had never been implemented, making that
   falsifier vacuous. Implemented as PREREG-001 6 F4 specifies.
3. `9ba01260` — the PREREG-001 6 PC-01 gate was firing under F6 and converting
   F6's preregistered reds into unrunnables. Exempted under F6 only; armed
   everywhere else.

4. `9100103` (finding 1) — an unrecognised `--scenario` ran a full unmutated
   baseline, labelled the packet with that name, and cited a fabricated
   `PREREG-001 6 <name>`. An unknown scenario is now a harness error.
5. `9100103` (finding 2) — no packet encoded any falsifier's expected red, so a
   falsifier that had stopped falsifying was indistinguishable from one that
   worked. A scenario table now carries each run's mutation, expected reds,
   expected passes and expected unrunnable classes, evaluated into the packet.
6. `9100103` (finding 3) — X and L were declared UNRUNNABLE under F6 citing a
   packet rule that does not exist, against 3.7. They now record FAIL.
7. `9100103` (finding 4) — the packet wrote the pinned hash constant rather than
   the observed sandbox hashes 1.3 asks for, hiding F5's own mutation. Observed
   hashes are now recorded, with the four unpinned copies recorded not gated.
8. `9100103` (finding 5) — the PC-01 gate was keyed on the scenario label rather
   than on whether the index actually exists.
9. `9100103` (finding 6) — a non-zero exit was charged as a budget breach, which
   let a dead retriever override its own declared UNRUNNABLE.
10. `9100103` (finding 9) — fixed case ids and stale-index rows were
   dereferenced unguarded and per-class counts were never checked. An integrity
   block now fails closed; `--self-check` is its runnable witness.

Corrections 4 to 10 came from the non-author Rule-26 review at head `a72f68b`.
None of them touched a threshold, `tau`, K, a class count, a query, a gate, a
budget or a corpus byte, and the three frozen fixture hashes were re-verified
byte-identical before and after. Every reported result was re-executed on the
corrected instrument and reproduced the previous baseline numbers exactly.

4. `9100103` (finding 1) — an unrecognised `--scenario` ran a full unmutated
   baseline, labelled the packet with that name, and cited a fabricated
   `PREREG-001 6 <name>`. An unknown scenario is now a harness error.
5. `9100103` (finding 2) — no packet encoded any falsifier's expected red, so a
   falsifier that had stopped falsifying was indistinguishable from one that
   worked. A scenario table now carries each run's mutation, expected reds,
   expected passes and expected unrunnable classes, evaluated into the packet.
6. `9100103` (finding 3) — X and L were declared UNRUNNABLE under F6 citing a
   packet rule that does not exist, against 3.7. They now record FAIL.
7. `9100103` (finding 4) — the packet wrote the pinned hash constant rather than
   the observed sandbox hashes 1.3 asks for, hiding F5's own mutation. Observed
   hashes are now recorded, with the four unpinned copies recorded not gated.
8. `9100103` (finding 5) — the PC-01 gate was keyed on the scenario label rather
   than on whether the index actually exists.
9. `9100103` (finding 6) — a non-zero exit was charged as a budget breach, which
   let a dead retriever override its own declared UNRUNNABLE.
10. `9100103` (finding 9) — fixed case ids and stale-index rows were
   dereferenced unguarded and per-class counts were never checked. An integrity
   block now fails closed; `--self-check` is its runnable witness.

Corrections 4 to 10 came from the non-author Rule-26 review at head `a72f68b`.
None of them touched a threshold, `tau`, K, a class count, a query, a gate, a
budget or a corpus byte, and the three frozen fixture hashes were re-verified
byte-identical before and after. Every reported result was re-executed on the
corrected instrument and reproduced the previous baseline numbers exactly.

The earlier runs that exposed corrections 1 and 3 are reported as instrument
shakedown runs in the Phase B build ledger, not as preregistered results.

### Known instrument residue

Recorded, not changed. Each was raised by the non-author Rule-26 review at head
`a72f68b` and deliberately left alone, because changing any of them would move a
terminal or a definition that only a `PREREG-002` ruling may move.

- **Finding 7 — dead-retriever DENY/SKIP terminals.** `scoreWithheld` records
  FAIL when the search process exits non-zero, so F6 shows ten "leaks" across
  the DENY, SKIP and operator skip/deny cases even though both of PREREG-001
  3.5's FAIL conditions are false there (no canary reached stdout, and no row
  was returned at all). The packet enumerates F6's expectations for PC-01,
  positive, temporal, operator and negative only, and is silent on C, S, X and
  L. Recorded rather than reclassified: a terminal change here needs a
  `PREREG-002` ruling, not a runner edit.
- **Finding 8 — 4.3 item 3 enforced more narrowly than written.**
  `environmentGaps()` declares the model UNRUNNABLE when the local
  transformers.js cache file is absent, although packet 4.3 item 3 accepts
  weights resolved "either from its local cache **or over the network on first
  use**". On this machine the distinction is moot because `huggingface.co` is
  unreachable, so the narrow check and the packet's check agree here. It would
  wrongly declare UNRUNNABLE on a machine with network access and a cold cache.
- **Finding 10 — duplication inside the runner.** Three hand-rolled
  inject-row/restore sites (the F4 one has no restore and takes only the first
  chunk of a multi-chunk donor, harmless because every corpus note is a single
  chunk); three recursive directory walkers; the frontmatter-stripping regex
  written out three times; `pristine` re-parsed rather than reused. Also
  `DENY_PREFIXES` omits the backslash normalization `deny-list.mjs:51` applies,
  dormant because the committed fixture prefix contains no backslash, and the
  runner's classifier is deliberately an independent reimplementation rather
  than an import of the product's. Left as residue: consolidation is worth doing
  only as a pure refactor that reproduces byte-identical packets.

## Product identity under test

```text
repository               wrg32786/aigent-os
commit                   cdb7022e5a08ef78f9923944fb4aff51bfea48a1
tree                     8ebd2ed02116a16e5e7315766d76ddc6d13b0ec8
manifest schema          FleetBaselineManifest/v6
baseline_id              aigent-os-2026-08-24-867cb2ea
```

All eight runtime hashes pinned in PREREG-001 1.3 were verified against the
worktree at this commit and match, byte for byte:

```text
daemons/semantic-search/namespace-registry.json               5bcc603c8e813f272be3ef17aa94b92ac1cccd9e31fb5b02d6d5589d60025060  MATCH
daemons/semantic-search/namespace-registry.local.example.json 8628cf7d921f091865ea9142dc936de3b16e0d97c0515da60118650fdd285212  MATCH
daemons/semantic-search/namespace-registry.mjs                2e3ebb9c539f5deb7eddb2ce838f73b2d18ddc06bf5a01970df8ce337168d0e8  MATCH
daemons/semantic-search/search-vault.js                       202ba3929c5e6e15de6d3e2761e3278dc64f28e24792a084a8959e536df4b8f5  MATCH
daemons/semantic-search/embed-vault.js                        51ff0ca5180d8a7f03501bddf4f94bc22ba80027f89588dd2bca34793a2bb0f3  MATCH
daemons/semantic-search/deny-list.mjs                         5ff063ae3e9bb114fec464bd446675dfe2be72fe92d046e7f23ebe8c0d15f95c  MATCH
daemons/lifecycle-common.mjs                                  bc6ee45666f4537c41a6de9b2f4f12afa504549ef258191d26698f0fdbbe1ba3  MATCH
evals/run-evals.mjs                                           11d4a79d47e3349113df56a856411b434055b3c5321c913abc017583995e836d  MATCH
```

## Resolved embedding model identity

PREREG-001 residue item 3: the product pins no model weight identity,
`MODEL_NAME` is only a name (`embed-vault.js:37`, `search-vault.js:47`), and
transformers.js resolves the weights from cache or network. The weights
actually resolved for this run are recorded here so a later run on different
bytes is visible rather than assumed equivalent.

```text
model name               Xenova/all-MiniLM-L6-v2   (quantized: true)
transformers.js          @xenova/transformers 2.17.2
resolution               local transformers.js FileCache, no network fetch
cache directory          daemons/semantic-search/node_modules/@xenova/transformers/.cache/
                         Xenova/all-MiniLM-L6-v2/

config.json               7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7
onnx/model_quantized.onnx afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1
tokenizer.json            da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0
tokenizer_config.json     9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3
```

Provenance of those bytes, stated plainly: `huggingface.co` is not reachable
from this machine (TLS connection reset on every attempt; unrelated hosts
resolve and return 200, so the block is host-specific). The weights were
therefore taken from an existing transformers.js FileCache already present on
this machine and copied into the worktree's package cache. PREREG-001 4.3 item
3 accepts either a local cache or a network fetch, so this satisfies the
requirement; the four hashes above are what makes the choice auditable.

## Execution environment

PREREG-001 4.3 item 7 and residue item 6.

```text
operating system         Windows 11 Pro, build 10.0.26200
platform / arch          win32 / x64
CPU                      Intel(R) Core(TM) Ultra X7 358H, 16 logical processors
total memory             68191178752 bytes
Node.js                  v24.15.0     (requirement: >= 22.0.0, met)
python3                  present      (doctor namespace extractor)
bash                     present      (scripts/doctor.sh)
```

A run is comparable only to runs on the same declared OS family, because ONNX
float arithmetic can move a cosine score in the fourth decimal (PREREG-001 4.3
item 7). Scores are compared at four decimals, and the runner flags any case
whose top-1 score sits within 0.01 of `tau` as near-threshold so a
cross-platform flip is visible rather than mysterious (residue item 4).

## What this file does not do

It does not record any result. It fixes the identities the results will be
reported against. No threshold, `tau`, K, class count or definition is
established, altered or reinterpreted here.
