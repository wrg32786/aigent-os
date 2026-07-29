# Rendering-site inventory

This inventory is for the production source in this worktree after the
rendering-boundary changes. A **direct render** is a source-to-sink flow that
can place generated instruction, orientation, advisory, denial, or
procedure-command text in a model-facing channel, or install/pass such text
to a model runtime. A **persisted precursor** is a production write whose
output is consumed by one of those renderers later.

The counts at the end count source-to-sink flows (table rows), not files or
individual string interpolations. A flow with several source and sink lines
is counted once. A pipeline can therefore have one counted precursor and one
counted direct render: each is an independently editable boundary.

## Population swept

- JavaScript: every production `.js`, `.mjs`, and `.cjs` below `daemons/`,
  `hooks/`, `launcher/`, `scripts/`, and `tools/`: **42 files** (40
  `daemons/`, 1 `hooks/`, 0 `launcher/`, 0 `scripts/`, 1 `tools/`).
- Shell: every production `.sh` in the repository, including root
  `install.sh`: **28 files** (14 `daemons/`, 6 `hooks/`, 2 `launcher/`, 3
  `scripts/`, 2 `skills/`, and root `install.sh`).
- Python: every production `.py` in the repository: **6 files** (5
  `daemons/`, 1 `skills/`).

For all three languages, files below `test/`, `tests/`, `fixture/`, or
`fixtures/`, and test/spec-named files were excluded from the production
population. Documentation, examples, dependencies, `.git`, and generated
vault data were also excluded as implementation files. Vault documents,
capsules, transcripts, indexes, and runtime state are nevertheless named
below when production code reads them as data sources. The structural reader
implementations (`daemons/frontmatter-reader.cjs`,
`daemons/lifecycle-common.mjs`, `daemons/raw-acquisitions.mjs`, and
`daemons/render_boundary.py`) are supporting boundaries rather than additional
source-to-sink flows.

Operator-only CLI diagnostics, the status-line display, semantic-search
result presentation, and presentation/media build output were inspected but
are not counted: none is generated prompt/procedure text or a persisted
input to a listed automatic renderer. Fixed text is counted when external
state selects whether that text is injected.

## Structural guard coverage and declared limits

Population inclusion is not the same as rule coverage. The structural guard
counts all of the JavaScript, shell, and Python files above and keeps sentinel
files in each population. It enforces local parser/delimiter declarations,
reason-gated raw access, JavaScript raw-file render use, and these additional
probe-shaped render boundaries:

- JavaScript file-backed JSON assigned to a plain object binding, with that
  object's member used by the four committed same-block template-expression
  vectors (`json-read-interpolation`).
- JavaScript scalar readers that compare slices against `'-'.repeat(3)`
  delimiters (`frontmatter-delimiter-expression`).
- Direct `execSync` results and `spawnSync` stdout/stderr/output used by a
  template render (`child-process-interpolation`).
- Direct `process.env` access inside a template render
  (`environment-interpolation`).
- JavaScript `unsafeRaw*` non-call uses in the six committed alias/escape
  spellings: `const` and `let` aliases, renamed destructuring, member
  assignment, `return`, and a call argument (`unsafe-raw-indirection`).
- Python direct `open(...).read()` assignments used by the six committed
  f-string vectors, plus three context-manager vectors in the same function:
  `fh.read()` to an f-string, `fh.readlines()` to literal `.format(...)`, and
  `fh.read()` to literal concatenation (`python-read-interpolation`).
- Shell direct `$(cat FILE)` assignments forwarded to an unpiped `printf`
  render, plus the committed inline `printf ... "$(cat FILE)"` and
  `echo "... $(<FILE)"` vectors (`shell-read-interpolation`).
- Python frontmatter-delimiter bindings proven by committed vectors: literal
  `"---"` passed to `split`, function-local `"-" * 3` passed to `split`, and
  function-local `"--" + "-"` passed to `partition`
  (`frontmatter-delimiter-variable`).

Two files remain in the counted populations and sentinel assertions but are
wholly exempt from structural rule evaluation by design:
`daemons/frontmatter-reader.cjs` and `daemons/render_boundary.py`. They define
the canonical parser and raw-reader source shapes that the guard prohibits
everywhere else. `daemons/tests/render-boundary.test.mjs` behaviorally defends
the JavaScript reader's exports, complete line-breaking collapse, Unicode
separator handling, reason-gated raw access, and the historical
escaped-newline specimen. `tests/test_runtime_paths.py` behaviorally defends
the Python exports, decoded capsule and `ACTIVE_STATE.json` single-line
invariants, reason-gated raw access, and separator-safe rewriting.

JavaScript outside the five scanned roots is explicitly excluded:

- `evals/run-evals.mjs` under `evals/` is a CI-only fixture/JSON evaluation
  harness. It reads corpora and `.claude/skill-index.json`, exercises
  production code, and has no independent parser or production render
  boundary.
- `assets/build-terminal-demo.mjs` under `assets/` is presentation-asset build
  and drift-check code.
- `skills/frontend-slides/bold-template-pack/deck-stage.js` under `skills/` is
  presentation/media build code.

Named static-analysis residue includes direct Python `os.environ[...]` and
`subprocess.check_output(...)` expressions inside f-strings. These are direct,
single-expression flows, not merely interprocedural taint. Python
`Path.read_text()`, other reader/render spellings, and values carried through
helpers or objects also remain uncovered.

JavaScript destructuring directly from file-backed JSON, such as
`const { objective } = JSON.parse(...)` followed by same-block interpolation,
is not matched by `json-read-interpolation`. Shell residue includes
`read -r value < file`, `mapfile`/`readarray` file reads, and `$(<file)` outside
the exact committed inline `echo` vector. Assignment, transformation, other
sink spellings, and substitutions carried through functions remain uncovered.
Network input, stdin as a data channel, and arbitrary dynamic or
interprocedural propagation are residue as well.

Enumeration is itself a designed limit. Every guard predicate is a regular
expression over source text anchored to surface syntax, so a new spelling
requires a new committed red vector and usually a new or extended predicate.
The guard rejects the known shapes listed above; it cannot certify the
source-to-render class. Canonical readers and behavioral rendering tests are
the class-level defense.

Several predicates also have declared character ceilings.
`rawReadInterpolations` permits 500 characters on each side of an assigned
variable in a template expression and 500 characters in the selected sink
spans. The line-scalar `startsWith` and `indexOf` predicates stop after 400 and
500 characters, respectively; the shell `unsafeRaw*` function-body check stops
after 500. The expression-delimiter slice comparison and
`dynamic-scalar-parser` stop after 160 characters. A sufficiently long site can
therefore pass because it is long, not because its flow is safe. These ceilings
remain residue in this round and were not re-engineered.

## JavaScript direct renders

| ID | Site | Source → sink |
|---|---|---|
| JS-D01 | `daemons/discipline-check.mjs:67-74,121-132` | Stop-hook assistant text → confident-verb count (content is not echoed) → one model-facing discipline advisory. |
| JS-D02 | `daemons/gateguard.mjs:108-118,186-191` | PreToolUse Edit `file_path` → `inert()` path in the Edit fact checklist → `permissionDecisionReason`. |
| JS-D03 | `daemons/gateguard.mjs:121-131,186-191` | PreToolUse Write `file_path` → `inert()` path in the Write fact checklist → `permissionDecisionReason`. |
| JS-D04 | `daemons/gateguard.mjs:57-73,134-152,195-202` | Bash command shape → a fixed destructive-command or first-command checklist → `permissionDecisionReason`; the raw command is only classified/keyed and is not rendered. |
| JS-D05 | `daemons/memory-budget-guard.mjs:44-64,90-97`; `daemons/memory-hygiene/budget.mjs:89-106` | Proposed Write/Edit content plus current governed memory file → constrained basename and numeric size verdict → consolidation denial procedure. |
| JS-D06 | `daemons/model-tier-guard.mjs:49-63,72-87,89-97` | Agent-definition `name`/`model` frontmatter plus requested model → quoted, bounded mismatch advisory or block reason. |
| JS-D07 | `daemons/nightly-alerts.mjs:31-72,85-100,215-235`; `daemons/sessionstart-reinject.mjs:99-106` | Active nightly-alert ledger events/read errors → quoted code, summary, evidence, and file → immediate delivery and SessionStart alert lines. |
| JS-D08 | `daemons/precompact-flush.mjs:108-145,164-174` | Stop-writer spawn error/status → quoted failure detail → strict-mode PreCompact block procedure. |
| JS-D09 | `daemons/precompact-flush.mjs:108-145,177-192,229-232` | Stop-writer outcome/failure detail → fixed status line or quoted warning → non-strict PreCompact table-of-contents injection. |
| JS-D10 | `daemons/precompact-flush.mjs:68-88,193-200,229-232` | `BODY_STATE.json` capsule pointer plus seat/path → contained capsule selection and quoted reference header → PreCompact injection. |
| JS-D11 | `daemons/precompact-flush.mjs:193-206,229-232` | Active capsule `objective`, `next_valid_action`, and `waiting_on` → shared single-line reader → `inert()` fields in the PreCompact table of contents. |
| JS-D12 | `daemons/precompact-flush.mjs:51-65,207-214,229-232` | Intentional multiline `Pending-Gates` body → reason-gated raw body access → per-row quoted/bounded rendering with announced row/character truncation. |
| JS-D13 | `daemons/precompact-flush.mjs:198-199,215-227,229-232` | Capsule path/section references or outside/dangling pointer path → quoted on-disk links and pointer-fault recovery text → PreCompact injection. |
| JS-D14 | `daemons/resume-verb.mjs:46-88,115-155,183-223,226-242` | Selected capsule path, id, timestamps, scalar fields, and derived autosave/age state → quoted data block below fixed fences → post-clear resume procedure. |
| JS-D15 | `daemons/resume-verb.mjs:92-113,158-169,222-242` | Capsule selector rejection ledger → bounded grouped filenames/details and computed counts → “CAPSULES NOT SELECTED” section in the resume procedure. |
| JS-D16 | `daemons/sessionstart-reinject.mjs:79-85,118-132,149` | SessionStart `source` and coordination-state file → quoted source plus fixed coordinated-cycle, clear-resume, or warm-start procedure branch. |
| JS-D17 | `daemons/sessionstart-reinject.mjs:138-149,212` | Operator-authored `identity-core.md` → reason-gated raw memory-document access → intentional multiline SessionStart procedure text. |
| JS-D18 | `daemons/sessionstart-reinject.mjs:152-186,212` | Newest valid capsule path and scalar fields → shared single-line readers plus `inert()` → bounded warm-start capsule orientation. |
| JS-D19 | `daemons/sessionstart-reinject.mjs:189-195,212` | `HEAT_INDEX.json` hot-note names/paths → per-entry `inert()` → bounded “Hot notes” orientation line. |
| JS-D20 | `daemons/sessionstart-reinject.mjs:197-212` | Intentional raw read of `SESSION_LOG.md` → select one heading only → quoted/bounded “Last session-log entry” orientation line. |
| JS-D21 | `daemons/curated-close-pointer.mjs:17-19,51-83` | Capsule path/frontmatter, seat, and write failures → contained shared-reader values plus `inert()` → curated-close refusal or stamped-pointer receipt visible to the invoking procedure. |

## JavaScript persisted precursors

| ID | Site | Source → persisted sink → later renderer |
|---|---|---|
| JS-P01 | `daemons/nightly-alerts.mjs:104-175` | Nightly producer fields → collapsed/bounded `NIGHTLY_ALERTS.jsonl` raised/delivery events → JS-D07. |
| JS-P02 | `daemons/stop-capsule-writer.mjs:197-213,270-346,359-390,425-546` | Reason-gated transcript delta (operator/peer text, tool paths/errors, claims, assistant text) → autosave capsule frontmatter and anchored body sections → JS-D10 through JS-D15 and JS-D18. |
| JS-P03 | `daemons/curated-close-pointer.mjs:51-81` | Curated capsule shared-reader scalars/path → `BODY_STATE.json.state.last_capsule` → JS-D10 and downstream capsule renderers. |
| JS-P04 | `daemons/memory-heat/compute-heat.js:201-243,283-332` | Vault note paths, reads, backlinks, pins, and mtimes → `HEAT_INDEX.json` hot/cold path arrays → JS-D19. |
| JS-P05 | `hooks/tool-tracker.js:62-110` | PostToolUse name and privacy-safe metadata → quoted, single-line capture record on stdout → `hooks/auto-capture.sh` and the shell persisted-summary flow below. |
| JS-P06 | `daemons/lifecycle-common.mjs:250-260`; `daemons/sessionstart-reinject.mjs:57-61`; `daemons/stop-capsule-writer.mjs:60-65` | Exception tags/messages → quoted, bounded, single-line `.daemon-errors.log` records → SH-D24. |

## Shell direct renders

| ID | Site | Source → sink |
|---|---|---|
| SH-D01 | `daemons/caddy-detect-new-skill.sh:11-75` | PostToolUse Write/Edit path plus skill index → validated skill name and quoted path → model-facing `/caddy-enroll` nudge. |
| SH-D02 | `daemons/caddy.sh:18-20,60-109` | User prompt pattern matches and mute state → selected fixed routing/memory/context/body hint lines → UserPromptSubmit stdout. |
| SH-D03 | `daemons/caddy.sh:115-170` | User prompt plus `.claude/skill-index.json` name/triggers/why → validated name and quoted reason → top-two Caddy hints. |
| SH-D04 | `daemons/caddy.sh:179-213` | User prompt words plus `memory/SKILL_LEDGER.md` row fields → quoted skill/path/description taxonomy fallback or fixed gap hint. |
| SH-D05 | `daemons/caddy.sh:215-229` | User prompt overlap plus `memory/SKILL_CHAINS.md` chain cell → quoted prior-chain hint. |
| SH-D06 | `daemons/skill-router.sh:30-60,62-143` | User prompt plus legacy/typed skill-card index fields → validated alias/name and quoted description, matched triggers, and model → structured Caddy skill hint. |
| SH-D07 | `daemons/caddy.sh:233-235` | Output from `skill-router.sh` → unchanged forwarding to the UserPromptSubmit channel. |
| SH-D08 | `daemons/memory-capture.sh:229-232,257-262,337-357` | Candidate backlog or injection-guard exit code → fixed/numeric cap or scan-failure instruction → Caddy stdout. |
| SH-D09 | `daemons/consciousness-boot.sh:23-42,46-57,60-149` | Skill index, hook wiring, `BODY_STATE.json`, sweep age, and router state → quoted/derived bounded fields → boot manifest procedure. |
| SH-D10 | `daemons/somatic/reflex-body.sh:8-31` | `BODY_STATE.json` pressure and recommended-reflex fields → fixed pressure instructions plus quoted reflex → UserPromptSubmit somatic hint. |
| SH-D11 | `daemons/somatic/reflex-digest.sh:5-8` | Count of staged `MEMORY_CANDIDATES.md` rows → numeric `/digest` instruction. |
| SH-D12 | `daemons/somatic/reflex-sweep.sh:5-10` | `HESTIA_SWEEP_LOG.md` presence/latest constrained date → fixed or numeric `/sweep-now` instruction. |
| SH-D13 | `hooks/security-scan.sh:10-48` | PostToolUse response and tool name → known-pattern severity/count plus constrained tool token → model-facing untrusted-data warning; matched content is not echoed. |
| SH-D14 | `hooks/suggest-compact.sh:5-17` | Session id-derived counter and threshold → numeric `/clear` efficiency suggestion. |
| SH-D15 | `hooks/session-end-check.sh:1-5` | Session-end event → fixed `/close` reminder. |
| SH-D16 | `daemons/codex-adapter.sh:48-55,82-85,107-122` | Operator CLI task argument → reason-gated intentional raw multiline value → Codex `exec` prompt (also recorded in the private run log). |
| SH-D17 | `install.sh:407-451` | Repository `CLAUDE.md` → reason-gated raw managed block → installed `CLAUDE.md` procedure. |
| SH-D18 | `install.sh:452-473` | Existing operator-authored `CLAUDE.md` outside managed markers → reason-gated byte-preserving refresh → installed `CLAUDE.md`. |
| SH-D19 | `install.sh:484-497` | Reviewed post-compact rule file → reason-gated raw promotion → `.claude/rules/post-compact-critical.md`. |
| SH-D20 | `install.sh:499-525` | Reviewed skill directories, including multiline `SKILL.md` files → reason-gated raw tree promotion → `.claude/skills/`. |
| SH-D21 | `install.sh:527-553` | Eligible operator-authored agent definitions → reason-gated raw promotion → `.claude/agents/`. |
| SH-D22 | `scripts/doctor.sh:131-157` | `doctor --fix` eligible agent definitions → reason-gated raw repair copy → `.claude/agents/`. |
| SH-D23 | `launcher/install.sh:51-70` | Source skill directories, including multiline `SKILL.md` files → reason-gated raw promotion → runtime `.claude/skills/` copy performed by the launcher installer. |
| SH-D24 | `daemons/system-check.sh:32-147,300-320,428-445` | Environment/configuration, capsule validation, child-check output, and recent daemon diagnostics → reason-gated raw acquisitions followed by quoted/bounded `render_inert()` fields → model-visible `/system-check` report. |
| SH-D25 | `install.sh:323-327,375-400` | Reviewed top-level `system/` and `skills/` trees → reason-gated raw procedure-tree promotion → installed operating documents and skill sources. |
| SH-D26 | `install.sh:555-664` | External install target plus settings template → parsed JSON replacement, shell-context escaping, and ASCII JSON serialization → generated `.claude/settings.json` hook procedures. |
| SH-D27 | `launcher/install.sh:74-190` | External checkout root plus settings template → parsed JSON replacement, shell-context escaping, ASCII JSON serialization, and a symlink-safe atomic install → generated launcher `.claude/settings.json` hook procedures. |
| SH-D28 | `launcher/install.sh:12-41,209-215` | External `AIGENT_HOME` argument → full control-character rejection plus Bash `%q` quoting → persisted executable shell-profile assignment. |

## Shell persisted precursors

| ID | Site | Source → persisted sink → later renderer |
|---|---|---|
| SH-P01 | `daemons/caddy-reindex.sh:22-62,75-97` | Skill-catalog frontmatter → locally collapsed flat `.claude/skill-index.json` → SH-D03/SH-D06. |
| SH-P02 | `daemons/memory-capture.sh:32-64,104-121,238-312` | User prompt memory-authoring match → quoted/bounded `MEMORY_CANDIDATES.md` row → digest and SH-D11; rows remain `unscanned` until the injection guard promotes them. |
| SH-P03 | `hooks/auto-capture.sh:14-41` | JS-P05 quoted capture line → today’s `vault/daily/*.md` `Session Captures` section → SH-P04. |
| SH-P04 | `hooks/session-capture-summary.sh:40-155` | Intentional multiline daily capture section → parsed quoted cells, bounded tool/file sample → persisted single-line daily-note summary used by later memory orientation/reconciliation. |
| SH-P05 | `hooks/log-token-usage.sh:12-18,20-86,90-111` | Session transcript usage/model/timestamps → derived numeric row in `vault/memory/usage_log.md` → `/open` and `/close` context/cost procedures. |
| SH-P06 | `daemons/sync-usage.sh:16-49` | Most-recent transcript token totals and bounded session basename → `memory/usage_log.md` → `/open` and `/close` context/cost procedures. |
| SH-P07 | `daemons/caddy.sh:15,27,98,115,234`; `daemons/consciousness-boot.sh:10,23,60`; `daemons/memory-capture.sh:15,26-34,337-357`; `daemons/skill-router.sh:13,30`; `hooks/session-capture-summary.sh:10,144` | Shell/Python child failures and scan details → `.daemon-errors.log` → reason-gated recent-error acquisition and inert rendering in SH-D24. |

## Python direct renders

| ID | Site | Source → sink |
|---|---|---|
| PY-D01 | `daemons/agent-fitness-extract.py:68-132,166-225,235-248` | Session JSONL/path and dispatch scan result → bounded path/session plus derived counts/errors → model-visible `/agent-fitness extract` command response. |
| PY-D02 | `daemons/agent-fitness-report.py:29-53,89-161` | `AGENT_FITNESS.md` rows → derived counts/ratios/trends with quoted agent/task fields → `/agent-fitness` procedure report. |
| PY-D03 | `daemons/capsule-compact.py:129-188` | Capsule-chain/CLI state → quoted paths/ids and derived chain counts → `/capsule-compact` procedure response. |
| PY-D04 | `daemons/runtime/update-active-state.py:247-346,349-372` | Memory/capsule-derived active state → quoted objective/mode/reflexes → runtime-update procedure response. |

## Python persisted precursors

| ID | Site | Source → persisted sink → later renderer |
|---|---|---|
| PY-P01 | `daemons/agent-fitness-extract.py:68-132,186-219` | Agent tool-use/result transcript fields → quoted, bounded `AGENT_FITNESS.md` table rows → PY-D02. |
| PY-P02 | `daemons/capsule-compact.py:73-83,108-116,154-171` | Older capsule id/created/objective scalars → quoted summary bullets → new chain-summary capsule. |
| PY-P03 | `daemons/capsule-compact.py:84-95,111-112,154-171` | Intentional multiline `open_threads` body → selected bullet rows, each `inert()` → new chain-summary capsule. |
| PY-P04 | `daemons/capsule-compact.py:96-107,113-114,154-171` | Intentional multiline held-decisions body → selected bullet rows, each `inert()` → new chain-summary capsule. |
| PY-P05 | `daemons/capsule-compact.py:49-70,173-183` | Existing capsule frontmatter/body → reason-gated raw parts for byte-preserving relink/`compacted_into` mutation → future capsule readers. |
| PY-P06 | `daemons/capsule-compact.py:119-127,149-171` | Validated head id and numeric compaction options → summary id/objective/frontmatter → future capsule readers. |
| PY-P07 | `daemons/runtime/update-active-state.py:247-337,346,355-360` | `BODY_STATE.json`, capsule scalars, priorities/log/trackers, and prior runtime state → recursively single-lined `ACTIVE_STATE.json` → runtime/orientation procedures. |
| PY-P08 | `daemons/runtime/update-active-state.py:339-346,361-365` | Derived mode/objective transitions → recursively single-lined JSON events → `STATE_EVENTS.jsonl` for later runtime procedure history. |
| PY-P09 | `daemons/agent-fitness-extract.py:237-247` | Fitness-extraction exceptions → inert single-line `.daemon-errors.log` record → reason-gated recent-error acquisition and inert rendering in SH-D24. |

## Count summary

The table-row convention above yields:

| Language | Direct render flows | Persisted precursor flows | Total enumerated flows |
|---|---:|---:|---:|
| JavaScript | 21 | 6 | 27 |
| Shell | 28 | 7 | 35 |
| Python | 4 | 9 | 13 |
| **Total** | **53** | **22** | **75** |

These are flow counts, not unique-file counts. In particular, the same
capsule pipeline is counted at its writer and at each independently editable
model-facing renderer, while repeated interpolation of fields within one
renderer is kept in one row.
