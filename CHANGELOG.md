# Changelog

All notable changes to aigent-OS are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

For changes to the kernel itself (the 15 numbered system documents and extended specs), see [`system/CHANGELOG.md`](system/CHANGELOG.md).

## [Unreleased]

### Added
- **Two-verb lifecycle** — `/context-capsule` and `/resume` replace `/open`/`/close`/`/pause` as the session-continuity model. See `docs/two-verb-lifecycle.md` for the full design.
  - `daemons/lifecycle-common.mjs` — shared identity/vault resolution, CRLF-safe frontmatter flip (`flipCapsuleToResumed`) with dedupe of a pre-seeded null-stamp placeholder.
  - `daemons/capsule-content-gate.mjs` — shared injection-echo / ceremony-action content gate.
  - `daemons/capsule-verb.mjs` + `daemons/curated-close-pointer.mjs` — the trusted-writer path: validates capsule content, collects deterministic evidence (git always, board pluggable via `AIGENT_BOARD_ADAPTER`), stamps the one pointer at `BODY_STATE.json`'s `state.last_capsule`, verifies the stamp read-back.
  - `daemons/reconcile-collector.mjs` + `daemons/effect-receipts.mjs` — deterministic, model-free evidence collection; the effect-receipt ledger is a business-OS seam, unwired by default.
  - `daemons/refresh-cycle.mjs`, `daemons/refresh-request.mjs`, `daemons/refresh-cursor.mjs` — the transactional cycle record, the controller→session challenge-crossing request, and the byte-exact transcript capture-cursor primitive.
  - `daemons/resume-verb.mjs` — the resume verb's runtime container, a new `SessionStart(clear)` hook.
  - `daemons/sessionstart-reinject.mjs` — warm-start pointer-table reinject, a new `SessionStart` hook covering every source (startup/resume/clear/compact) in one merged file.
  - `daemons/stop-capsule-writer.mjs` — every-turn rolling capsule delta writer, a new `Stop` hook. Includes a speaker-tag classifier (`OPERATOR`/`RELAY:x`/`PEER:x`/`INJECT:harness`) so injected instructions and cross-session relay text never masquerade as the operator's own objective.
  - `daemons/ctx-refresh-sensor.mjs` — optional context-pressure self-refresh reflex, a new `PreToolUse` hook. Silently inert unless a statusline integration writes `~/.claude/ctx-refresh/<sid>.json`.
  - `.claude/settings.json.template` — wires the four new hooks above.
  - `skills/context-capsule/SKILL.md`, `skills/resume/SKILL.md` — rewritten to the two-verb contract.
  - `skill-index.json` — added `sk_resume`; `sk_open`/`sk_close` marked `active: false` (deprecated, not removed).
  - `docs/two-verb-lifecycle.md` — the design doc.
  - Test suite: `daemons/tests/*.test.mjs` (8 files) — content gate, trusted writer, resume verb, the CRLF-safe flip, the pointer clobber-guard, the challenge-crossing request, the capture-cursor primitive, and the speaker-tag classifier.

### Known issue
- Fresh autosave capsules seed `waiting_on: null`, which the content gate correctly refuses as non-resumable — an automated refresh cycle can be refused against a just-created autosave capsule until a later turn fills in a real `waiting_on`. Documented in `docs/two-verb-lifecycle.md`; the fix is planned as a follow-up commit on this branch, not bundled into this port.

### Changed
- `docs/capsule-v2-doctrine.md` — added a forward pointer to the two-verb lifecycle doc; the v2 field schema is unchanged and still current.
- `skills/open/SKILL.md`, `skills/close/SKILL.md` — marked deprecated in favor of `/resume` and `/context-capsule`; kept for manual invocation during the transition, not deleted.

## [0.8.0] — 2026-07-07 — "Public readiness pass"

Identity-framing consistency, three new doctrine notes, and a genericization sweep ahead of public release.

### Changed
- `system/00_identity.md` — resolved the operator-identity contradiction: consistently frames the user as a technical operator/principal who installs (`install.sh`), runs `/open` → work → `/close`, and can read/edit any part of the system, matching the posture already described in `README.md`.
- `CLAUDE.md` — First-Run Behavior section brought in line with the same operator framing.
- `vault/concepts/MAP.md` — Doctrine Index extended with the three new notes below; removed a dangling `[[agents/Pantheon]]` wikilink (no such note exists — the Roster section already serves that purpose).
- `vault/concepts/Engineering Judgment Doctrine.md` — its "operating philosophy pillars" reference now links to the new `Core Operating Ethos` note instead of naming the pillars in unlinked prose.

### Added
- `vault/concepts/Core Operating Ethos.md` — six operating pillars: system not a ticket queue, asymmetric cost of failure, anticipate the next failure, defaults matter, head-down over premature surfacing, six-month durability test.
- `vault/concepts/Review Before Push.md` — doctrine: no agent-written diff reaches a shared branch without a reviewer pass returning a ship / no-ship verdict; only a designated pusher merges.
- `vault/concepts/Orchestration Lanes.md` — three delegation lanes (standing collaborative team, one-shot fan-out subagents, solo-inline) and the habit of declaring the lane before a substantive build.

### Fixed
- Genericization pass across skill docs and vault notes ahead of public release — internal reviewer/agent example placeholders in `skills/honesty-check/SKILL.md`, `vault/memory/HONESTY_LEDGER.md`, and `skills/trust-decay/SKILL.md` no longer reference specific private agent names; `skills/skill-index.json`'s core-ethos card description genericized; `vault/feedback/Browser harness - just connect.md` genericized to "the operator" / "agents."
- Removed stray `.claude/skill-index.json.tmp` and `skills/skill-index.json.tmp` build artifacts.
- Removed a fully duplicated nested copy of the `frontend-slides` skill under `skills/frontend-slides/plugins/frontend-slides/`.
- Removed `vault/concepts/CLAUDE.md Thinning Plan.md` — an internal working note, not public content.

## [0.7.0] — 2026-05-09 — "The Cognitive Architecture"

Persistent self-model, structured beliefs, goals that survive sessions, and a human-gated dream cycle for self-improvement.

### Added
- The 4-Level Learning Stack: Facts (`memory/facts/facts.jsonl`) → Procedures (`memory/runtime/PROCEDURES.jsonl`) → Strategies (`memory/runtime/LESSONS.jsonl`) → Self-modification (`/dream` + `/meta-improve`)
- Runtime consciousness files: `ACTIVE_STATE.json` (computed live state), `SELF_MODEL.json` (capabilities/limitations/failure modes), `GOAL_STACK.json` (persistent goals with success criteria), `BELIEF_STATE.jsonl` (confidence-scored assumptions), `STATE_EVENTS.jsonl` (state-transition log), `LEARNING_SCORECARD.md` (did learning prevent recurrence?)
- `/reconcile` — weekly cross-system consistency check (goals vs priorities vs beliefs vs facts)
- `/dream` — offline consolidation, proposes improvement candidates after /close or weekly
- `/meta-improve` — implements approved improvements via branch-test-approve-merge
- `/status` — 12-line operational heartbeat summary
- Eval harness
- `docs/meta-aigent-doctrine.md` — safety framework: `/dream` proposes, `/meta-improve` implements on a branch, only the principal approves merges; aigent-OS may never self-approve, self-merge, or expand its own authority

## [0.6.0] — 2026-05-08 — "The Self-Learning Engine"

aigent-OS expands its own capability surface instead of stopping at inability — recalls, hunts, works around, learns, and captures every failure as a durable artifact, automatically.

### Added
- Skill Recall — Caddy searches the skill index by taxonomy on every prompt
- Skill Hunt — auto-fires when recall finds no match, searches GitHub and skill marketplaces for missing capabilities
- Solution Hunt — finds 3 alternate routes when blocked (direct fix, workaround, replace)
- Learn from Failure — classifies failures, checks repetition via `FAILURE_MODES`, produces durable artifacts (rule/skill/Caddy trigger/checklist) on the second occurrence
- Capsule v2 — resumable execution state with `waiting_on`, `success_criteria`, `next_action`; `/close` creates, `/open` offers resume
- Temporal Facts — `memory/facts/facts.jsonl`, facts with provenance, validity windows, supersede chains; auto-captured on `/close`
- Skill Gap Scan — weekly scan for open capability gaps older than 7 days, auto-run on `/open`
- Key files: `memory/SKILL_LEDGER.md` (taxonomy-structured skill index), `memory/SKILL_GAPS.md`, `memory/SKILL_CHAINS.md` (proven multi-skill sequences)
- Recommended third-party skills documented (sql-builder, query-optimizer, migration-generator, git-workflow, pdf-workflow, data-visualization, api-docs, api-design)

## [0.5.1 → 0.5.3] — 2026-05-03 — "Polish + auto-wiring"

Three small wiring releases that close the v0.5 arc.

### v0.5.1 — Working `/agent-fitness` report + heuristic refinement

- `daemons/agent-fitness-report.py` — new. Prints per-agent calibration table + recent trend + repeat-blocker callouts + top failing pairs. `--days N` window flag.
- `skills/agent-fitness/SKILL.md` updated to document 3 modes (extract / report / report-windowed)
- `daemons/agent-fitness-extract.py` — heuristic refined (added 11 blocked/partial keywords); SystemExit no longer swallowed by catch-all
- `daemons/memory-capture.sh` — `rule:` regex tightened to require sentence boundary

### v0.5.2 — `/close` runs `/system-check`

- `.claude/commands/close.md` Step 7.5 added — every /close audits the wired Somatic stack
- PASS → one-line summary; FAIL → details surfaced, /close does not block; INFO → daemon error log entries surfaced

### v0.5.3 — Stop hooks for vault-write daemons

- `.claude/settings.json.template` — adds Stop hooks for `log-token-usage.sh` + `agent-fitness-extract.py`
- `log-token-usage.sh` was self-declared as a Stop hook but never actually wired (silent-success caught and fixed)
- Found another Git-Bash path bug: Python on Windows native can't open `/c/...` paths in Stop hook commands. Fixed by switching to `C:/...` form for python invocations. Bash invocations keep `/c/...` (bash handles natively).

## [0.4.1 → 0.5.0] — 2026-05-03 — "Somatic stack — full reflection arc"

Six wiring releases shipped in one session. v0.4 (sense) was already in production. v0.4.1 → v0.5.0 layer on top: rhythm, input, reflection, Hestia wiring, capsule chain compaction, agent fitness. Each layer was synthetic-tested before the next layered on. The 1-2-cycle gate was overridden in this release on principal authority; future releases return to the gate.

### v0.4.1 — Rhythm

- `vault/memory/BODY_STATE.json` schema extended with `last_capsule` field
- `.claude/commands/open.md` Step 2.5 — capsule resume offering
- `.claude/commands/close.md` Step 0.5 — auto-integrations (skip-digest if 0 staged, auto-create capsule, demote prior active capsule)
- `skills/context-capsule/SKILL.md` — capsule lifecycle (active → resumed → resolved) + parent_capsule_id chain
- `skills/caddy-mute/SKILL.md` — new skill, 5 classes (memory/context/body/routing/all), 4h default expiry
- `daemons/caddy.sh` — class-mute helper (Git-Bash → Windows path translation), 5 existing hints class-tagged, 3 new hints (memory/context/body)
- `vault/memory/CADDY_MUTES.json` — schema initialized

### v0.4.2 — Input (auto-capture)

- `daemons/memory-capture.sh` — high-confidence trigger phrases auto-stage candidates to MEMORY_CANDIDATES
- 50-row hard cap, 24h dedupe window, append-only
- 7 trigger patterns: `remember that X`, `remember to X`, `from now on X`, `new rule: X`, `rule: X` (tightened to require sentence boundary), `we decided/agreed X`, `going forward X`
- Best-effort: capture script failure does NOT block Caddy hint output

### v0.4.3 — Reflection (smoke test)

- `skills/system-check/SKILL.md` + `daemons/system-check.sh`
- Audits: 8 wired skills, 8 daemons (parse), 7 state files (valid + fresh), capsule frontmatter sanity, mirror discipline (vault ↔ public), daemon error log surfacing
- Reports: green/red per path, exits 0 if all PASS

### v0.4.4 — Hestia wiring

- `skills/sweep-now/SKILL.md` — dispatches Hestia sub-agent for 3 vault sweeps (DELEGATION_TRACKER stale items, HEAT_INDEX dormant flips, broken wikilinks), appends entry to HESTIA_SWEEP_LOG
- `skills/body-check/SKILL.md` — reads HESTIA_SWEEP_LOG mtime → `hestia_last_sweep` field; null OR >7d → `recommended_reflex: sweep`
- `vault/memory/HESTIA_SWEEP_LOG.md` template — initialized empty

### v0.4.5 — Capsule chain compaction

- `daemons/capsule-compact.py` + `skills/capsule-compact/SKILL.md`
- When parent_capsule_id chain >= 5, summarize oldest 3 into a chain-summary capsule
- Compacted capsules stay on disk with `compacted_into:` marker for archeology
- Idempotent: re-running on already-compacted chain is a no-op

### v0.5.0 — Agent fitness (the big one)

- `daemons/agent-fitness-extract.py` — scans Claude Code JSONL transcripts for `Agent` tool dispatches, classifies outcome (clean/blocked/errored/partial) via heuristic, appends rows to AGENT_FITNESS.md
- `skills/agent-fitness/SKILL.md` — surfaces calibration ratios per sub-agent
- `vault/memory/AGENT_FITNESS.md` template — initialized with schema header
- Dedup by (session_id, tool_use_id) — idempotent extract

### Doctrine banked alongside

- `vault/concepts/Somatic Layer.md` — base doctrine
- `vault/concepts/Somatic Roadmap.md` — version queue + ship history
- `vault/concepts/Somatic v0.4.1 Wiring.md` through `vault/concepts/Somatic v0.5.0 Agent Fitness.md` — 6 spec docs
- "Silent successes hide failures" doctrine — `2>/dev/null` and `exit 0 on no-op` are anti-patterns; vault daemons log to `<vault>/memory/.daemon-errors.log`
- Doubled-write rule — every skill/daemon change writes to BOTH local `.claude/skills/` AND public `skills/`. Prevents v0.4 wiring gap recurrence.

### Bugs found and fixed in this release

- v0.4.1 Caddy class-mute Python heredoc was passing Git-Bash `/c/...` paths that Python on Windows native could not open; mute file silently failed to load → mute system never worked. Fixed with path translation at top of heredoc.
- v0.5.0 dedup was extracting truncated session/tool_use IDs from the ledger but checking against full IDs → re-runs would duplicate rows. Fixed by storing full IDs in ledger.
- v0.4.2 `rule:` regex was matching mid-sentence ("what's the rule for X") as doctrine. Tightened to require sentence boundary + colon + space.
- v0.5.0 outcome classifier missed real blocked patterns ("BLOCKED:", "are denied", "blocker-found"). Added 11 keywords.

### Earlier-banked agents (still in this release window)

- `vault/agents/echo.md` — Haiku scout instrument
- `vault/agents/lyra.md` — Sonnet builder instrument
- `vault/agents/newton.md` — Sonnet research synthesist
- `vault/agents/iris.md` — Sonnet visual designer
- `vault/agents/mnemosyne.md` — Sonnet memory architect
- `vault/agents/hypatia.md` — Sonnet critic
- `vault/agents/hestia.md` — Sonnet custodian (now wired via v0.4.4 sweep-now)

## [0.2.2] — 2026-04-27 — "Measurement primitives + adversarial doctrine"

Foundation for the v0.3 measurement release. Six original inventions ship as
doctrine + skills + scaffolds. None of them depend on v0.3 measurement skills
to be useful immediately; together they establish the data substrates that
v0.3 will build on.

### Added

**Adversarial doctrine (principal-side discipline):**
- `vault/concepts/Reading Agent Output Defensively.md` — companion to `/honesty-check`. Tells the principal how to spot when an agent didn't volunteer the truth. 10 patterns of confident-sounding bullshit + the standard push-back move.

**Cost of Confidence (longitudinal trust calibration):**
- `vault/concepts/Cost of Confidence.md` — names the pattern: every confident claim that turns out wrong is a trust-decay event.
- `skills/trust-decay/SKILL.md` — two-phase ledger skill. Phase 1 captures confident claims; Phase 2 resolves them as right or wrong. Pairing is the whole point.
- `vault/memory/TRUST_DECAY.md` — the ledger file (Open + Resolved sections; auto-managed).

**Common Failure Modes (institutional debugging memory):**
- `vault/concepts/Common Failure Modes.md` — names the pattern: every confirmed `/diagnose` outcome becomes Phase 1 corpus; recurring patterns graduate to Phase 2 doctrine.
- `vault/memory/FAILURE_MODES.md` — corpus file (Phase 1 entries + pattern frequency tracker).
- `skills/diagnose/SKILL.md` — extended with Step 6: write verified diagnosis outcomes to the corpus.

**Honesty Ledger (structured artifact, not just doctrine):**
- `vault/memory/HONESTY_LEDGER.md` — longitudinal record of `/honesty-check` outputs. Pairs to TRUST_DECAY.md when discrepancies surface.
- `skills/honesty-check/SKILL.md` — extended to also write a structured machine-readable entry per invocation. Resolution field updated by `/trust-decay resolve` later.

**Attention Reconciliation (drift detection at /open):**
- `vault/concepts/Attention Reconciliation.md` — the doctrine. Where you said you'd spend attention vs where you actually did, computed every session.
- `skills/open/SKILL.md` — extended with two new protocol steps:
  - Step 7: decision aging check (surfaces 30/60/90-day decisions awaiting outcome capture)
  - Step 8: attention reconciliation (compares last 7 days of daily notes to ACTIVE_PRIORITIES, flags drift > 20%)

**Promote (conversation → durable artifact):**
- `skills/promote/SKILL.md` — selective elevation skill. Take a slice of the current conversation and produce a vault concept / project / person / decision artifact. Pairs with `/close` (transient) by handling the durable layer.

**Caddy:**
- `.claude/skill-index.json` — added `/promote` and `/trust-decay` entries with rich triggers.

### Changed
- `/honesty-check` skill produces both human-readable summary AND machine-readable ledger entry per invocation.
- `/diagnose` skill writes Phase 1 corpus entries on verified diagnoses.
- `/open` skill protocol now includes decision aging + attention reconciliation steps before main orientation output.

### Authority reasoning
All AL1 (additive doctrine + auto-capture extensions to existing skills + scaffold files). No kernel changes; no breaking changes; all measurement layer is data-collection-only at this release. v0.3 will ship the analyzers (`/retro`, `/skill-economics`, `/quality-pulse`) that consume this data.

### What's NOT in this release (deferred to v0.3)
- `/retro` quarterly analysis skill — needs at least 30 days of TRUST_DECAY + HONESTY_LEDGER + FAILURE_MODES data
- `/skill-economics` — needs Caddy hint-followed tracking (Caddy improvement queued separately)
- `/quality-pulse` — Friday three-question survey skill
- Cadence enforcement hooks (D2 from v0.3 brief)
- `/missed-cadence` skill (D3)

## [0.2.1] — 2026-04-26 — "Caddy elevation"

### Added
- **Doctrine plane (Caddy as canonical):**
  - `vault/concepts/Caddy.md` — promoted from local install. The full doctrine note for Caddy (the non-blocking skill router). Includes provenance: original aigent-OS contribution, designed by Will Gwyn 2026-04-13. Not a port.
  - `vault/concepts/Suggestion Credibility.md` — names the principle that justifies Caddy's design: *agent suggestions are a depleting trust resource.* Generalizable doctrine for any advisory system.
  - `vault/concepts/The Self-Management Layer.md` — umbrella concept for the patterns that keep the framework coherent without manual maintenance. Members: Caddy, Self-Improving CLAUDE.md, Memory Decay, /diagnose, /system-check, /skill-audit, decision aging.
- **Caddy-supporting skills (preserve non-blocking constraint):**
  - `/caddy-explain` — walks Caddy's deterministic scoring on demand. Inspectability ↔ legibility thesis.
  - `/caddy-mute` — bounded-duration suppression for flow protection. Auto-restores; never permanent.
  - `/caddy-audit` — quarterly hygiene pass. Detects index/file drift (orphans in either direction, trigger staleness).

### Changed
- README hero — extended to surface the toolbox-manages-itself claim alongside the legibility thesis: "*An AI that operates on itself — and a toolbox that manages itself, on top of it.*"
- `vault/concepts/The Seven Layers.md` — added Caddy cross-layer footprint section (Caddy lives across L2/L3/L4/L6; cross-layer is a feature, not a bug).
- `skills/diagnose/SKILL.md` — Layer 2 check now includes `/caddy-explain` and `/caddy-audit` for Caddy-specific diagnostics.
- `.claude/skill-index.json` — added 3 new Caddy skills with rich Caddy-aggressive trigger keywords.

### Authority reasoning
All AL1 (doctrine + non-blocking skills + cross-references). No new behavior; no kernel changes; no breaking changes.

## [0.2.0] — 2026-04-26 — "The editorial release"

### Added
- **Manifesto + thesis:**
  - `docs/manifesto.md` — names the [[Legibility Thesis]] explicitly. AI memory belongs to the principal, in a format the principal can read.
  - README rewrite — new tagline "The personal operating system that operates itself"; new "How this repo maintains itself" section; Posture/bio-hacking section.
- **Doctrine drop (9 new concept notes):**
  - `Legibility Thesis.md` — the meta-doctrine
  - `The Two Roles.md` — principal-as-user vs maintainer
  - `Skills Graduation Curve.md` — phases at 5/15/30/50+ skills, why Caddy is essential
  - `Three Rules.md` — verify-before-claim, smallest-change, tell-the-truth (constitutional)
  - `Negative Space Discipline.md` — what disciplined agents refuse to do
  - `Bio-hacking Posture.md` — the principal tunes, doesn't consume
  - `What I Am Not Building.md` — explicit rejection list (template)
  - `Modern AI Infrastructure Stack.md` — reference map of where each layer sits
  - `The Seven Layers.md` — the AIgent's internal architecture (kernel → principal config)
- **Adoption skills (3):**
  - `/system-check` — audits install integrity
  - `/skill-audit` — flags dead skills, detects Caddy trigger mismatches
  - `/diagnose` — walks the seven-layer stack to identify failing layer
- **Agent-discipline skills (7, sourced from external playbook with attribution):**
  - `/envelope` — Ship / Ask one focused question / Propose
  - `/self-review` — spawn reviewer subagent with 4-6 specific verification questions
  - `/honesty-check` — volunteering ledger before declaring done
  - `/first-10-moves` — operational recon for unfamiliar codebases
  - `/stuck` — 6-rung escalation ladder
  - `/timeline-calibration` — self-correct timeline estimates from human-dev anchors
  - `/sandbox-routing` — self-correct tool choice for large outputs
- **Learning capture:**
  - `/learn` skill — captures evaluations as structured notes (ADOPT/HOLD/REJECT/MONITOR)
  - `vault/concepts/learning/INDEX.md` — auto-maintained index of all `/learn` captures
- **Measurement scaffolding:**
  - `vault/memory/DECISION_OUTCOMES.md` — outcome aging tracker for decisions logged in DECISION_LOG. 30/60/90-day check-in points. Data feed for `/retro` (forthcoming v0.3).
- **Security:**
  - `SECURITY.md` (root) — real disclosure policy. Uses GitHub native private vulnerability reporting (no email channel needed).
  - `docs/install-security.md` — trust model for the curl|bash one-liner. Four verification options.
- **Kernel changelog:**
  - `system/CHANGELOG.md` — separate audit trail for kernel changes (higher-stakes than skills/hooks).
- **Examples:**
  - `vault/examples/` — example notes showing what good vault content looks like.
  - `vault/concepts/Common Anti-Patterns.md` — operating rules that prevent common agent failure modes.
  - `CONTRIBUTING.md` — contribution guide.
  - "Who this is for" + comparison sections in README.

### Changed
- "15 markdown files" → "15-document kernel + extended specs" throughout README and CLAUDE.md (matches reality; previously misrepresented).
- Model identifiers in routing tables — now explicitly noted as "latest in tier" rather than pinned versions; survives Anthropic version bumps.

## [0.1.0] — 2026-04-25

### Added
- Initial public release
- 15 system documents (`00_identity.md` → `14_decision_framework.md`)
- 5 extended system docs (`finance_agent.md`, `aigent_operating_system.md`, `aigent_delegation_map.md`, `aigent_memory_and_continuity.md`, `aigent_tools_and_plugins.md`)
- Hook scripts: auto-capture, session summary, token tracker, suggest-compact, security scan
- Skills: `/open`, `/close`, `/brief`, `/decide`, `/deep-recon`, `/semantic-search`, `/caddy-enroll`
- Daemons: `caddy.sh`, `semantic-search/`, `memory-heat/compute-heat.js`
- Doctrine notes: Self-Improving CLAUDE.md, Caddy (initial), Memory Decay Doctrine, Feature Design Workflow, External Toolkit Learnings Pattern
- One-line install via `bash <(curl -s https://.../install.sh)`
- MIT license

