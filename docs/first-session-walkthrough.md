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

## 2. Every session after this one starts already primed

You don't run anything to pick up where you left off. Continuity is two pieces, both automatic:

- **A warm pointer-reinject** runs on every session start (`daemons/sessionstart-reinject.mjs`) — a lightweight touch that keeps the last capsule's pointer live in context.
- **`/resume`** runs the full procedure whenever a session starts from a `/clear` (`daemons/resume-verb.mjs`): it loads the newest valid capsule by `created_at`, re-reads the session log and active priorities to re-ground, and then acts on the capsule's `next_valid_action` — not just summarizes it.

A typical resume looks like:

```
[new session — the last capsule's waiting_on was "get sign-off on the auth
 refactor brief"]
AI:  Picking up where we left off — the auth refactor brief was waiting on your
     sign-off, and nothing since has changed that. Want to review it now, or
     is something else more urgent today?
```

If you want to pick up a specific thread instead of the most recent one, `/resume <capsule_id>` loads that capsule instead.

## 3. Work the session

Just talk. The AI handles:

- **Routing** — when you ask for code, it spawns a sub-agent on the right model. When you ask for a strategy decision, it stays in the main session.
- **Memory** — every action is auto-captured to the daily note via the `auto-capture.sh` hook.
- **Authority** — it acts within Level 1 (autonomous), recommends within Level 2 (recommend & confirm), and stops at Level 3 (human only). See `system/12_authority_matrix.md`.
- **Delegation** — if it spawns a sub-agent, the brief follows the structured template in `system/05_delegation_protocol.md`.

You don't have to think about any of this. It runs.

## 4. When you wrap up, the state is already banked

There's no command you have to remember to run. A rolling, best-effort capsule autosave fires on every `Stop` event (`daemons/stop-capsule-writer.mjs`) — if you just close the terminal, the next `/resume` still has something real to act on.

When you want a clean, deliberate checkpoint instead — a thread genuinely wrapping, a handoff, or a pause before something risky — run `/context-capsule`. It:

1. **Reconciles** from the live session log, active priorities, and this session's git commits (2–4 reads, not a transcript re-read).
2. **Writes** a capsule to `vault/memory/capsules/<YYYY-MM-DD>-<slug>.md` with the fields a fresh session needs to act on: `id`, `objective`, `waiting_on`, `next_valid_action`.
3. **Stops.** One line acknowledging the capsule path, then silence — it doesn't stamp a pointer or digest — there is none; `validateCapsuleText()` (`daemons/capsule-verb.mjs`) can check the required fields and reports problems if anything is missing.

A typical explicit checkpoint looks like:

```
You: /context-capsule
AI:  Capsule written: vault/memory/capsules/2026-04-25-onboarding-v2.md
     Waiting on your sign-off on the auth refactor brief; next action is
     reviewing it together tomorrow.
```

The capsule is best-effort autosave, never a gate — you never wait on it, and it never blocks a `/clear` or a fresh session.

## 5. See your context and manage it

**The operating loop, spelled out:**

| Command | When | What it does |
|---------|------|-------------|
| `/resume` | Start of a session — auto-fires on `SessionStart(clear)`; run it by name for a named-capsule pickup | Loads the newest valid capsule by `created_at`, re-grounds against the session log and priorities, acts on `next_valid_action` |
| `/context-capsule` | Checkpoint or end of a thread — a rolling autosave version auto-fires on every `Stop`; run it by name for a deliberate checkpoint or handoff | Reconciles, writes a resume-ready capsule, then stops. Stamps nothing itself — `validateCapsuleText()` is the self-check |

`/open` and `/close` are retired — the skill files still exist for compatibility but are deprecated. You'll never be asked to run them.

**Why this matters:** Every Claude Code session has a finite context window. As the session grows, older content compresses and eventually the model loses fine-grained recall. The capsule autosave preserves the concrete next step before that happens.

**Set up your context counter (do this once):**

Run `/statusline` in Claude Code and enable the context usage display. This adds a live indicator showing how full your context is. When it approaches the limit, the built-in context-pressure sensor already nudges you — a soft nudge toward a checkpoint-then-clear at 60%, a mandatory `/clear` at 75%. You can also do it yourself any time:

1. Run `/context-capsule` (banks a clean checkpoint)
2. `/clear` (or start a fresh conversation)
3. `/resume` fires automatically and picks the state back up — you're back in full context with nothing lost.

Claude Code's built-in `/compact` summarizes context in-place; `/clear` wipes it outright. Both are lower-level tools. The aigent-OS rhythm (checkpoint, then clear) is preferred because it also banks a resume-ready capsule to the vault -- you get the context relief and a durable record of where you left off.

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
