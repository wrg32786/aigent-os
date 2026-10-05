# Hindsight and Jev memory bridge

Status: opt-in implementation; independent review and live-service verification required before deployment. No claim of improved recall quality, complete learning, or a passed capability benchmark.

`daemons/memory-bridge.mjs` connects the existing local semantic-search CLI to Hindsight and TypeSafe Jev. The module uses Node's standard library and the existing namespace, deny and persisted-text renderer. It does not replace the vault, install a database, add a supervisor, run lifecycle hooks, or change normal `search-vault.js` behavior.

## What is implemented

| Operation | Behavior |
| --- | --- |
| `inspect` | Reports the current source SHA256 without sending content or editing policy. |
| `retain` | Sends one explicitly approved source revision to the configured Hindsight bank, with a stable document ID, a revision tag and source metadata. |
| `recall` | Runs existing local search, supplements it with source-checked Hindsight facts, and optionally lets Jev reorder approved candidates. |
| `reflect` | Requests a bounded Hindsight synthesis and returns an inert HOLD candidate only when all cited memories map to the same request's checked local source links. |

No operation publishes, spends outside the configured providers, edits skills, ratifies a fact, rewrites a capsule, or promotes its own recommendation. Provider calls can incur usage charges. The module reports vendor token counts when supplied, not an invented dollar price.

## Setup after code review

Run a separately managed Hindsight server with a dedicated project bank. Use the [upstream installation guide](https://hindsight.vectorize.io/developer/installation) to choose local or hosted infrastructure. Pin the deployment version. A localhost server may itself call hosted extraction, embedding or reranking providers: localhost is not a no-egress guarantee. Do not install the upstream all-agent auto-ingestion hooks alongside this integration.

The bridge expects Node 22+ and an ordinary aigent-OS installation. Existing local search still requires its normal semantic-search dependency/model installation. Hindsight and Jev are independent: either can be enabled without the other.

Inspect a source before approving it:

```sh
node daemons/memory-bridge.mjs inspect --path research/example.md
```

The owner creates `.aigent/memory-bridge.json` (already gitignored) and inserts the exact reported SHA256. This example is deliberately DISABLED:

```json
{
  "schema": "MemoryBridge/v1",
  "sources": {},
  "hindsight": {
    "enabled": false,
    "url": "http://127.0.0.1:8888",
    "bank": "project-example",
    "allowQueries": false,
    "allowSources": false,
    "timeoutMs": 10000
  },
  "jev": {
    "enabled": false,
    "url": "https://api.typesafe.ai",
    "model": "jev-1.13.0",
    "allowQueries": false,
    "allowSources": false,
    "timeoutMs": 1500
  }
}
```

A source entry is `"research/example.md": "<64 lowercase hex characters>"`. There are no wildcard directories and no approval inherited merely from an INDEX disposition. Changed bytes require renewed approval. The allowlist applies to both providers; enabling a provider and its source flag approves those revisions for that provider. Query permission is separate and covers queries supplied to this explicit command, not unrelated session traffic.

Set `HINDSIGHT_API_KEY` for an authenticated Hindsight service and `TYPESAFE_API_KEY` for Jev in the calling process environment or through the operator's existing secret manager. Do not put keys in JSON, shell command arguments, source control or an agent prompt. The bridge does not discover credentials or enable paid usage.

Enable only the chosen provider after checking its endpoint and data policy, then run:

```sh
node daemons/memory-bridge.mjs retain --path research/example.md
node daemons/memory-bridge.mjs recall --query "What did we decide about the design?"
node daemons/memory-bridge.mjs reflect --query "What lesson is supported by the design evidence?"
```

`--root` and `--vault` select an installation explicitly; `AIGENT_ROOT` and `AIGENT_VAULT_ROOT` retain their existing meaning. No process-global settings are written. The `memory-bridge` skill provides the same explicit workflow; it is not an automatically invoked hook.

## Data and authority boundaries

1. Before content leaves, its live relative path must resolve to INDEX, avoid the existing deny prefixes, be a bounded regular Markdown file, contain no symlink traversal/hardlink alias, and match its approved SHA256. Unknown namespaces and malformed policy fail closed.
2. Hindsight uses one configured bank, never a shared implicit default. Each retained document has an `aigent-<path hash>` ID and an `aigent-source:<path-and-content hash>` tag. Recall requests only current approved revision tags, with `any_strict` matching. Returned metadata, document ID and tags are checked again locally.
3. Deleted, changed, revoked or cross-bank source references are withheld. Unknown remote facts are not rendered merely because the server returned them. Source links establish identity, NOT truth of an LLM extraction.
4. Both local excerpts and remote facts go through the existing `renderPersisted()` boundary. Returned data carries `authority: none`. Framing limits structural injection; it does not prove semantic immunity to malicious prose.
5. Local-first fusion alternates local and Hindsight candidates without adding incomparable scores. Candidates are deduplicated by path. Up to 16 enter ranking; at most 5 are returned. Local previews use current source text, not potentially stale stored-index text, and may differ from the old best-chunk preview.
6. Jev uses one bounded Choice request. Only approved source slots are reordered; unapproved local slots remain local. Every returned probability must be finite, valid and associated with exactly one supplied candidate. The result is a permutation, never pruning. `local_score` retains its original meaning; Jev order is not confidence, answerability, approval or the existing cosine threshold.
7. Reflection remains HOLD. Unknown cited memories, observations without verified links, mental models or directives cause a refusal rather than a source-backed claim. The bridge does not download and trust an entire bank to fill those gaps. Review the candidate and its source excerpts through the existing promotion process.

The configuration file is an owner-controlled trust boundary, not an authenticated human-consent system. An actor that can modify the owner configuration or run arbitrary code can bypass application-level policy. This bridge is not a sandbox, DLP system, or complete authorization solution.

## Failure, revocation and resource behavior

Missing configuration means local-only. A configured provider failure adds a machine-readable degraded notice; existing safe local results remain available. A missing or failed local search is reported separately, not presented as evidence the vault has no answer. `answerability` is always `not-evaluated`: zero results do not certify honest abstention.

HTTP requests have one attempt, an abort deadline covering response reading, no redirects and a bounded response. There is no retry daemon. A write timeout may still have completed upstream; retain returns UNKNOWN and names the stable document ID. Reconcile the document before retrying. Upstream upsert avoids accumulating duplicate documents but does not make network execution exactly once or prevent repeated provider billing.

Revoking a source locally stops this bridge from returning/exporting it but does NOT erase a previously retained server copy or vendor logs. Use Hindsight's existing document-delete command on the recorded bank/document ID after the appropriate approval, then verify removal. Do not mistake local exclusion for remote deletion. See [document management](https://hindsight.vectorize.io/developer/api/documents).

Current bounds: 64 approved files, 64 KiB per source, 16 rank candidates, 1,200 characters per preview, 1,500 UTF-8 query bytes, 24 KiB Jev request, 100 KB Hindsight request, 256 KiB response, provider deadlines 50-30,000 ms. The local CLI has a 30-second process deadline. These are conservative transport limits, not benchmark thresholds. Long documents need explicit editorial splitting before approval, not silent ingestion truncation. Source paths currently use a portable ASCII subset.

The filesystem checks assume an owner-controlled vault. They are not a complete defense against a hostile process racing directory replacements. Provider errors never include response-body echoes in notices. A provider outage cannot broaden namespace or egress permission.

## Upstream mining and adoption map

Examined Hindsight commit `f7dd3f4fd7420f7beec60c32c965e5e5cf7be066` (MIT) and TypeSafe's public System One API. This bridge is original integration code, not renamed upstream engine code; no upstream source or model weights are vendored. Hindsight remains a separately operated service, with its own license and provider terms.

| Upstream mechanism | aigent-OS treatment |
| --- | --- |
| Structured retain; document upsert; source metadata | Implemented through source-version-approved retain. Canonical Markdown stays local. |
| Semantic, keyword, graph and temporal recall | Reused through Hindsight's recall API, not reimplemented as a second local index. Quality remains to be measured. |
| Jev listwise Choice ranking | Implemented over the eligible candidate pool with strict response validation and visible fallback. |
| Jev relevance-cut/pruning | Not adopted. Upstream deliberately keeps at least one candidate; that cannot establish our no-answer contract. |
| Evidence-backed observations and mental models | Useful next C6 integration. Unknown consolidated provenance is refused here; no blind import or automatic policy promotion. |
| Reflect | Implemented as an explicit candidate-generation path, with checked source links and HOLD disposition. |
| Automatic coding-agent ingestion and boot pages | Not installed. They would add competing global hooks and a second automatic memory-write policy. |
| Typed procedure selection and issue triage | Design input for C3/C5, not an implemented permission or scheduler replacement. Deterministic selection stays deterministic. |
| Background provider failover | One visible local fallback in this slice. No retry controller or forced hidden hosted alternative. |

Source references:
- [Hindsight README at the inspected commit](https://github.com/vectorize-io/hindsight/blob/f7dd3f4fd7420f7beec60c32c965e5e5cf7be066/README.md)
- [Hindsight TypeSafeCrossEncoder](https://github.com/vectorize-io/hindsight/blob/f7dd3f4fd7420f7beec60c32c965e5e5cf7be066/hindsight-api-slim/hindsight_api/engine/cross_encoder.py)
- [Hindsight retain](https://hindsight.vectorize.io/developer/api/retain), [recall](https://hindsight.vectorize.io/developer/api/recall), [reflect](https://hindsight.vectorize.io/developer/api/reflect)
- [TypeSafe official API](https://docs.typesafe.ai/api)
- [Hindsight license](https://github.com/vectorize-io/hindsight/blob/f7dd3f4fd7420f7beec60c32c965e5e5cf7be066/LICENSE)

This separate feature does not modify any frozen recollection protocol, source corpus, threshold, runtime pin or current benchmark instrument. Performance evaluation of enriched recall needs its own approved, fixed method; do not relabel enriched output as a result from the existing local-only benchmark.

## Verification and next acceptance steps

Run `node --test daemons/tests/memory-bridge.test.mjs`. Tests use the actual HTTP client and production policy/renderer imports against a synthetic loopback service. They require no provider credentials or installed embedding model. The cross-platform workflow runs them on Linux, Windows and macOS; existing daemon discovery also includes them.

Before deployment: non-author code review, live API compatibility smoke with synthetic data, approved endpoints/keys and data policy, then a disposable seat. Before claims of better memory: independently measured positive/negative/temporal quality, source-revocation behavior, end-to-end latency, token consumption and actual provider usage. No live newsletter or business vault is a test fixture.
