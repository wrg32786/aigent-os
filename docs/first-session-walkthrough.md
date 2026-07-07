# First Session Walkthrough

A narrative walkthrough for new aigent-OS installs. Five minutes from clone to running.

---

## 0. Install

You already have the aigent-OS folder from your download. Open a terminal in the unzipped folder and run:

```bash
bash install.sh
```

The installer drops the framework files in place. No new directory. No build step. No virtualenv.

## 1. Open Claude Code

Start a new conversation in your installed environment. You don't need to read anything first. The AI knows it's a fresh install and will greet you.

A typical first exchange looks like this:

> **AI:** Welcome to aigent-OS — your AI operating system. I see this is a fresh install. Let me get you set up. I'll ask a few questions about who you are, what you're working on, and how you want me to operate. Takes about 5 minutes, and after that I'll know your context every time you open a session.
>
> Ready? Let's start — what's your name and what do you do?
>
> **You:** I'm Daisy, I run a 4-person SaaS startup. We're a year in, ~$30k MRR, my main job is product strategy and unblocking the engineering team.
>
> **AI:** Got it. I'll write that to your identity file. Two follow-ups:
>
> 1. What's a typical week look like for you? (rough split: deep work / meetings / firefighting)
> 2. What kinds of decisions do you want me to make on my own vs. always check with you?

The AI walks through identity, decision framework, authority levels, and active priorities. Each answer gets written to the right system file or vault note in real time. No forms. Just a conversation.

## 2. Run `/open`

Once setup is complete, every future session starts with `/open`. The AI loads:

- The most recent session note from `vault/daily/`
- The latest entry from `vault/memory/SESSION_LOG.md`
- Any open delegation items from `vault/memory/DELEGATION_TRACKER.md`
- Active priorities from `vault/memory/ACTIVE_PRIORITIES.md`
- The 20 hottest notes from `vault/memory/HEAT_INDEX.json` (if present)

A typical `/open` output looks like:

```
You: /open
AI:  3 open threads from yesterday.
     - Pricing decision pending (you said you'd think on it overnight)
     - Engineering brief for the auth refactor needs your sign-off
     - Onboarding flow draft ready for your review

     Active priorities, in order:
     1. Close the Series A bridge round (blocked on legal review)
     2. Ship onboarding v2 (in progress, ~70% done)
     3. Hire #5 engineer (interviews scheduled this week)

     Last session you were heads-down on the onboarding flow.
     Want to pick that up, or hit one of the open threads first?
```

## 3. Work the session

Just talk. The AI handles:

- **Routing** — when you ask for code, it spawns a sub-agent on the right model. When you ask for a strategy decision, it stays in the main session.
- **Memory** — every action is auto-captured to the daily note via the `auto-capture.sh` hook.
- **Authority** — it acts within Level 1 (autonomous), recommends within Level 2 (recommend & confirm), and stops at Level 3 (human only). See `system/12_authority_matrix.md`.
- **Delegation** — if it spawns a sub-agent, the brief follows the structured template in `system/05_delegation_protocol.md`.

You don't have to think about any of this. It runs.

## 4. Run `/close`

When you're done, run `/close`. It:

- Writes the session summary to `vault/daily/YYYY-MM-DD.md`
- Appends an entry to `vault/memory/SESSION_LOG.md`
- Updates `vault/memory/DECISION_LOG.md` if you made decisions
- Updates `vault/memory/DELEGATION_TRACKER.md` for any open handoffs
- Recomputes `vault/memory/HEAT_INDEX.json` so next session knows what matters

A typical close looks like:

```
You: /close
AI:  Session captured. Summary written to vault/daily/2026-04-25.md.

     What you decided today:
     - Pricing: going with $49/mo annual, $59/mo monthly. Logged.
     - Onboarding v2: ship Friday, no further scope additions.

     Open threads carrying to next session:
     - Engineering brief still pending your sign-off
     - Hire #5 — call back to candidate B by Tuesday

     See you tomorrow.
```

## 5. See your context and manage it

**The operating loop, spelled out:**

| Command | When | What it does |
|---------|------|-------------|
| `/open` | Start of every session | Loads vault memory, surfaces open threads, orients you |
| `/close` | End of every session | Commits memory, writes daily note, sets up next session pickup |

**Why this matters:** Every Claude Code session has a finite context window. As the session grows, older content compresses and eventually the model loses fine-grained recall. `/close` preserves everything before that happens.

**Set up your context counter (do this once):**

Run `/statusline` in Claude Code and enable the context usage display. This adds a live indicator showing how full your context is. When it approaches the limit, the rhythm is:

1. Run `/close` (banks the session to vault)
2. Start a fresh Claude Code conversation
3. Run `/open` (loads the banked state -- you're back in full context)

Claude Code's built-in `/compact` summarizes context in-place; `/clear` wipes it. Both are lower-level tools. The aigent-OS rhythm (`/close` then fresh session then `/open`) is preferred because it also commits memory to the vault -- you get the context relief and the permanent record.

## 6. Open your vault in Obsidian (optional)

If you install [Obsidian](https://obsidian.md) and open the `vault/` folder as a vault, you get:

- A visual graph of every connected note
- Backlink panels showing which notes reference each other
- Wikilink autocomplete when you write notes manually
- Full-text search of everything your AI has ever written for you

The vault is human-readable Markdown. You can edit any file directly and the AI will respect your edits next session.

## What to read next

- `docs/getting-started.md` — broader framework intro
- `docs/creating-agents.md` — how to add a new sub-agent
- `docs/skills.md` — how skills work and how to write your own
- `docs/security.md` — what the AI will and won't do
- `vault/concepts/Common Anti-Patterns.md` — operating rules that prevent common agent failure modes

## What to read when something feels off

- The AI surfaced too much / too little → `system/12_authority_matrix.md`
- The AI asked you a question it should have answered itself → `vault/concepts/Common Anti-Patterns.md`
- The AI forgot something between sessions → `system/13_memory_operating_layer.md`
- The AI wrote something to your vault you don't like → just edit the file. Next session it learns.
