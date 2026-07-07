---
name: setup
description: First-run setup — configure aigent-OS to know who you are and how you work
trigger: /setup
---

# aigent-OS Setup

Run this once after cloning the repo. aigent-OS will ask you a series of questions and configure the system documents and vault to match your specific context.

## Detection

If `system/00_identity.md` still contains the placeholder text "Replace this section with context about yourself", the AIgent should suggest running `/setup` automatically on first `/open`.

## The Interview

Walk through these sections one at a time. Ask naturally — this is a conversation, not a form. Adapt follow-up questions based on what the user shares. Don't ask all questions at once.

### Section 1 — Identity (→ writes to `system/00_identity.md`)

**Ask:**
- "What's your name and what do you do? Give me the quick version — role, businesses, responsibilities."
- "How do you like to work with AI? Direct and fast? Collaborative? Do you want me to push back on bad ideas or just execute?"
- "What's your risk tolerance? Are you cautious and methodical, or do you move fast and fix things later?"

**From the answers, fill in:**
- The "Your Principal" section of `system/00_identity.md`
- Optimization targets (what matters most to this person)
- Communication style preferences

### Section 2 — Priorities (→ writes to `vault/memory/ACTIVE_PRIORITIES.md`)

**Ask:**
- "What are you working on right now? Give me your top 2-3 priorities."
- "Which of these is the most urgent — the one that needs progress this week?"
- "Are you in growth mode, or are you stabilizing / fixing things right now?"

**From the answers, fill in:**
- Tier 1, 2, 3 priorities
- Operating mode (Stabilization / Build / Expansion)
- Any current blockers

### Section 3 — Authority Boundaries (→ writes to `system/12_authority_matrix.md`)

**Ask:**
- "What should I be able to handle without asking you? Think: routine stuff, research, organizing."
- "What should I recommend but wait for your approval on? Think: strategic moves, external communications, spending."
- "What should I never touch? Hard lines — things you always want to decide yourself."
- "Is there a dollar amount where spending decisions escalate to you? Like, anything over $X needs your sign-off?"

**From the answers, customize:**
- Level 1 (Autonomous) list with their specific examples
- Level 2 (Recommend & Confirm) list
- Level 3 (Human Only) list
- Dollar threshold for financial escalation

### Section 4 — Decision Logic (→ writes to `system/14_decision_framework.md`)

**Ask:**
- "When you're deciding whether to pursue something new, what do you look for? What makes you say yes vs. no?"
- "How many things can you actively work on before quality drops? 2? 3? 5?"
- "What's your biggest time trap — the kind of work that feels productive but doesn't actually move the needle?"

**From the answers, customize:**
- Pattern filter (what they look for in opportunities)
- Active bet limit
- Anti-drift rules specific to their patterns

### Section 5 — Projects & People (→ writes to `vault/projects/` and `vault/people/`)

**Ask:**
- "Let's set up your active projects. For each one: what is it, what's the current status, and what's the priority?"
- "Who are the key people I should know about? Partners, team members, key contacts — and what's their role relative to you?"

**From the answers, create:**
- One vault note per project in `vault/projects/` using the project template
- One vault note per person in `vault/people/` using the person template
- Update wikilinks in `ACTIVE_PRIORITIES.md` to reference the new project notes

### Section 6 — Agents (→ writes to `vault/agents/`)

**Ask:**
- "Do you want to set up any specialized agents now? For example: an engineering agent for code, a research agent for investigation, a creative agent for content? Or do you want to start with just me and add agents later?"

**If yes, for each agent ask:**
- "What should this agent be called?"
- "What's its job — what scope does it own?"
- "Should it run on a fast model (cheap, for simple tasks) or a mid model (smarter, for real work)?"

**Create** vault notes in `vault/agents/` using the agent template.

## After Setup

Once all sections are complete:

1. Confirm what was configured: "Here's what I set up: [summary]. Want to adjust anything?"

2. **Teach the session rhythm** — this is critical. Say something like:

   > "One last thing — how aigent-OS sessions work:
   >
   > **`/open`** — Run this at the start of every session. I'll load your context, check what's pending, and surface anything that needs attention. Takes a few seconds.
   >
   > **`/close`** — Run this at the end of every session. I'll save what happened, update the vault, and set up the next session so you never lose context.
   >
   > These two commands are the heartbeat of the system. `/open` boots me up with full awareness. `/close` makes sure nothing falls through the cracks. If you skip `/close`, the next session starts blind.
   >
   > Ready to go? Type `/open` to start your first real session."

3. Note in `vault/memory/SESSION_LOG.md`: "Initial setup completed. System configured for [name]."

## Rules

- **One section at a time.** Don't dump all questions at once. Have a conversation.
- **Adapt to what they share.** If someone gives a detailed answer, skip the follow-ups that were already covered.
- **Use their language.** If they say "side hustle" don't write "secondary venture." Mirror their vocabulary.
- **Don't over-ask.** If they seem done with a section, move on. They can always refine later.
- **Write files as you go.** Don't wait until the end. Update each file after its section is complete so progress isn't lost if the session ends early.
- **Skip sections if asked.** "I'll do that later" is a valid answer. Move to the next section.
