---
title: Skill Ledger
tags: [memory, skills, taxonomy, index]
aliases: [SKILL_LEDGER, skill index, capability index]
created: 2026-05-08
---

# Skill Ledger

Taxonomy-structured index of all installed skills and tool capabilities. Maintained by `/skill-recall` on every successful hunt; updated manually on new installs.

See [[concepts/Capability Expansion Doctrine]] for the expansion protocol. See [[concepts/Caddy Skill Recall Integration]] for how this feeds Caddy.

## Last indexed

2026-05-08 (Lyra, Phase 1 build)

---

## Taxonomy

### automation

- `automation.browser.harness` — Self-healing Chrome harness via CDP — [[concepts/Browser Harness]] — `/browser-harness`
- `automation.browser.youtube` — YouTube ops via Composio MCP (upload, playlists, analytics, comments) — `/youtube-automation`
- `automation.document.docx` — DOCX creation/editing — `/docx`
- `automation.document.xlsx` — XLSX creation/editing — `/xlsx`
- `automation.document.pptx` — PPTX creation/editing — `/pptx`
- `automation.document.pdf` — PDF reading/extraction — `/pdf`
- `automation.document.markitdown` — Markitdown document conversion — see [[concepts/markitdown]]
- `automation.scheduling.production` — Manufacturing production scheduling and bottleneck resolution — `/production-scheduling`

### research

- `research.deep.tavily` — Web-grounded search with citations via Tavily MCP — `mcp__tavily__tavily-search` + `mcp__tavily__tavily-extract`
- `research.deep.recon` — Multi-agent reconnaissance (Explorer/Associator/Critic/Synthesizer) — `/deep-recon`
- `research.deep.defuddle` — Extract clean markdown from web pages — `/defuddle`
- `research.deep.investigate` — 4-phase root cause debugging — `/investigate`
- `research.video.seek-analyze` — Persistent video intelligence via Memories.ai LVMM — `/seek-and-analyze-video`
- `research.video.analyzer` — Analyze video files — `/video-analyzer`
- `research.video.youtube-summarizer` — Extract transcripts + structured summaries from YouTube videos — `/youtube-summarizer`
- `research.codebase.graphify` — Turn codebase/folder into a navigable knowledge graph — [[concepts/Graphify]] — `/graphify`
- `research.codebase.understand-anything` — Analyze codebase to extract domain knowledge, architecture, onboarding — `understand-anything:understand` et al.
- `research.market.researcher` — Market analysis, competitive intelligence, opportunity sizing — (market-researcher skill)
- `research.audio.transcriber` — Transcribe audio to structured markdown via Whisper — `/audio-transcriber`

### content

- `content.writing.humanizer` — Remove AI-tell language patterns from text — `/humanizer`
- `content.writing.humanize-docs` — Transform AI-generated docs to human voice — `/humanize-docs`
- `content.writing.social` — Platform-specific social content (LinkedIn/Twitter/Instagram/TikTok) — `/social-content`
- `content.writing.social-orchestrator` — Cross-channel social publishing — `/social-orchestrator`
- `content.writing.content-creator` — Brand voice analysis + SEO blog post + social content frameworks — `/content-creator`
- `content.writing.content-strategy` — Content pillars, clusters, editorial roadmap — `/content-strategy`
- `content.seo.audit` — Full-site SEO audit (technical, on-page, schema, AI search) — `/seo`
- `content.seo.ai` — Optimize content for LLM citations (AI Overviews, ChatGPT, Perplexity) — `/ai-seo`
- `content.seo.research` — Reverse-engineer competitor YouTube channel SEO strategy — `/seo-research`
- `content.slides.frontend` — Animation-rich HTML presentations, anti-AI-slop aesthetics — [[concepts/Frontend Slides Skill]] — `/frontend-slides`
- `content.slides.animated-slideshow` — Full-length animated slideshow production — `/animated-slideshow`

### music

- `music.tts.fal-audio` — TTS/STT via fal.ai audio models — `/fal-audio`

### video

- `video.remotion.core` — Remotion domain rules (animations, audio, captions, FFmpeg, 3D) — `/remotion`
- `video.remotion.best-practices` — Remotion best practices reference — `/remotion-best-practices`
- `video.db.videodb` — Video perception + editing (ingest, index, search, edit, transcode) — `/videodb`
- `video.db.videodb-skills` — Guided first-time setup for VideoDB SDK — `/videodb-skills`
- `video.loop.ltx-test` — Full LTX t2v + RIFE + 60s loop pipeline locally with SSIM metrics — (ltx-test skill)
- `video.loop.ltx-prompt` — Translate scene concept into LTX-native narrative prompt pairs — (ltx-prompt skill)
- `video.loop.ltx-compare` — SSIM + MSE boundary comparison across LTX loop test outputs — (ltx-compare skill)
- `video.loop.ltx-corpus` — Curated library of validated LTX prompts with SSIM scores — (ltx-corpus skill)
- `video.loop.rife-bridge` — Practical-RIFE v4.25 interpolation bridge between two frames — (rife-bridge skill)
- `video.youtube.automation` — YouTube ops via Composio MCP — `/youtube-automation`
- `video.youtube.summarizer` — Extract transcripts + structured summaries — `/youtube-summarizer`

### operations

- `operations.memory.digest` — Review staged memory candidates, promote/skip/supersede — `/digest`
- `operations.memory.capture` — Auto-capture memory candidates from session (daemon) — `daemons/memory-capture.sh`
- `operations.memory.capsule` — Structured context preservation for session handoff — `/context-capsule`
- `operations.memory.capsule-compact` — Compact long capsule chains — `/capsule-compact`
- `operations.memory.semantic-search` — Vault search by meaning via local embeddings — `/semantic-search`
- `operations.vault.lint` — On-demand vault health check (orphans, stale claims, contradictions) — `/lint`
- `operations.vault.sweep` — Dispatch Hestia to run vault sweep — `/sweep-now`
- `operations.vault.obsidian-markdown` — Create/edit Obsidian Flavored Markdown — `/obsidian-markdown`
- `operations.vault.obsidian-cli` — Interact with running Obsidian instance — `/obsidian-cli`
- `operations.vault.obsidian-bases` — Create/edit Obsidian .base files — `/obsidian-bases`
- `operations.vault.json-canvas` — Create/edit Obsidian .canvas files — `/json-canvas`
- `operations.vault.graphify` — Vault/codebase to knowledge graph — `/graphify`
- `operations.session.open` — Session start, load vault context, check comms — `/open`
- `operations.session.close` — Session end, commit memory, write SESSION_LOG — `/close`
- `operations.session.sidequest` — Save session state for context switch — (sidequest skill)
- `operations.session.rewind` — Restore session context from last sidequest — (rewind skill)
- `operations.session.body-check` — Compose the AIgent's five pressures lazily — `/body-check`
- `operations.session.system-check` — Audit aigent-OS install (skills, hooks, daemons, vault) — `/system-check`
- `operations.scheduling.aigent-daily` — Orchestrate full daily agent workflow — `/aigent-daily`
- `operations.skills.recall` — Match current task to installed skills via taxonomy — `/skill-recall` *(Phase 1, new)*
- `operations.skills.hunt` — Hunt GitHub/marketplaces for skills matching a gap — `/skill-hunt` *(Phase 1, new)*
- `operations.skills.audit` — List skills by usage, flag dead ones, detect drift — (skill-audit skill)

### delegation

- `delegation.brief.create` — Package work into structured brief, post to Agent Ops — (delegation-brief skill)
- `delegation.brief.tracker` — Manage DELEGATION_TRACKER lifecycle — (delegation-tracker skill)
- `delegation.agent.lyra` — Dispatch Lyra (Sonnet builder) — `/lyra`
- `delegation.agent.echo` — Dispatch Echo (Haiku scout) — `/echo`
- `delegation.agent.newton` — Dispatch Newton (Sonnet research synthesist) — `/newton`
- `delegation.agent.mnemosyne` — Dispatch Mnemosyne (Sonnet memory architect) — `/mnemosyne`
- `delegation.agent.hypatia` — Dispatch Hypatia (Sonnet critic) — `/hypatia`
- `delegation.agent.hestia` — Dispatch Hestia (Sonnet custodian) — `/hestia`
- `delegation.agent.vitruvius` — Dispatch Vitruvius (Sonnet architecture reviewer) — `/vitruvius`
- `delegation.agent.demosthenes` — Dispatch Demosthenes (Sonnet prompt engineer) — `/demosthenes`
- `delegation.agent.iris` — Dispatch Iris (Sonnet visual designer) — `/sprite-spec`, `/visual-polish`, `/ui-architecture`

### design

- `design.frontend.impeccable` — Frontend interface polish, hierarchy, anti-bland design — `/impeccable`
- `design.frontend.taste` — Opinionated design judgment for premium feel — `/taste-skill`
- `design.frontend.design` — Distinctive, production-grade frontend code — `frontend-design:frontend-design`
- `design.frontend.react` — React best practices — `vercel:react-best-practices`
- `design.visual.sprite-spec` — Complete sprite specification for AI image-gen — `/sprite-spec`
- `design.visual.polish` — Prioritized polish actions across typography/spacing/color — `/visual-polish`
- `design.ui.architecture` — New UI surface design with component tree and motion — `/ui-architecture`

### security

- `security.audit.owasp` — OWASP Top 10 + STRIDE threat model — `/security-audit`
- `security.mode.careful` — Warn before destructive bash commands — `/careful`
- `security.mode.freeze` — Restrict Edit/Write to a specific directory — `/freeze`
- `security.mode.guard` — Full safety mode combining careful + freeze — `/guard`
- `security.mode.unfreeze` — Clear freeze boundary — `/unfreeze`

### finance

- `finance.analysis.core` — Financial analysis via Will's decision frameworks — (financial-analysis skill)
- `finance.analytics.channel-economics` — YouTube analytics refresh, monetization forecast — `/channel-economics`

### caddy

- `caddy.enroll` — Add skill to Caddy's index — (caddy-enroll skill)
- `caddy.mute` — Suppress Caddy hints for bounded duration — `/caddy-mute`
- `caddy.explain` — Walk Caddy scoring for a prompt — (caddy-explain skill)
- `caddy.audit` — Quarterly hygiene check of skill-index vs disk — (caddy-audit skill)



### context-engineering

- `context.mode.execute` — Sandbox bash execution with summary-only return — `context-mode:context-mode`
- `context.engineering.core` — Architectural guidance for production AI agent systems — `/context-engineering`
- `context.capsule.compact` — Collapse 5+ capsule chain into summary capsule — `/capsule-compact`

### productivity

- `productivity.review.office-hours` — YC-style product interrogation before any build — `/office-hours`
- `productivity.review.autoplan` — Full plan review gauntlet with auto-decisions — `/autoplan`
- `productivity.review.self-review` — Spawn reviewer subagent before declaring non-trivial work done — (self-review skill)
- `productivity.review.honesty-check` — Volunteering ledger before declaring done — (honesty-check skill)
- `productivity.routing.envelope` — Classify directive as Ship / Ask / Propose — (envelope skill)
- `productivity.routing.stuck` — 6-rung escalation ladder before declaring stuck — (stuck skill)
- `productivity.routing.route-or-delegate` — Self-correct inline Opus work — (route-or-delegate skill)
- `productivity.routing.sandbox-routing` — Self-correct tool choice for heavy bash ops — (sandbox-routing skill)
- `productivity.routing.first-10-moves` — Operational recon sequence for unfamiliar codebases — (first-10-moves skill)
- `productivity.calibration.timeline` — Self-correct timeline estimates — (timeline-calibration skill)
- `productivity.promote` — Elevate conversation slice to durable vault artifact — (promote skill)
- `productivity.trust-decay` — Two-phase ledger of confident agent claims and outcomes — (trust-decay skill)
- `productivity.diagnose` — Seven-layer aigent-OS stack diagnosis — (diagnose skill)

---

## Coverage gaps

*(Populated by `/skill-recall` when no taxonomy match is found. See [[memory/SKILL_GAPS]] for active entries.)*
