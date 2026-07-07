# deep-recon

Multi-agent reconnaissance skill for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) + [Obsidian](https://obsidian.md).

Four specialized agents run in parallel rounds to explore a topic from multiple angles, find unexpected connections, stress-test ideas, and produce a structured recon document with competing framings, developed tensions, and open questions.

## The Agents

| Agent | Style | Role |
|---|---|---|
| **Explorer** | Divergent | Casts the widest net — web searches, vault searches, adjacent fields, historical parallels |
| **Associator** | Lateral | Finds non-obvious connections — structural analogies, cross-domain pattern matching, productive metaphors |
| **Critic** | Adversarial | Stress-tests emerging ideas — prior art, hidden assumptions, steelmanned objections, productive contradictions |
| **Synthesizer** | Integrative | Identifies emergent patterns across all inputs — distinct framings, tensions worth preserving, the question the user hadn't considered |

## How It Works

The skill runs 2–3 rounds of parallel agent dispatch:

- **Round 1 — Wide net.** All four agents explore the topic simultaneously. The Explorer gathers raw material from the web and your vault. The Associator finds structural parallels in your existing notes. The Critic identifies prior art and assumptions. The Synthesizer maps what's emerging.

- **Between rounds.** In Interactive mode, the Synthesizer summarizes findings and asks which threads to pursue. In Autonomous mode, it directs the next round automatically — collapsing duplicates, pushing distinct framings further apart, identifying tensions that need development.

- **Round 2 — Deepening.** Agents receive all previous findings plus cross-pollination. The Explorer fills gaps and does reality checks. The Associator works connections between R1 findings. The Critic stress-tests the strongest ideas. The Synthesizer refines themes.

- **Round 3 (optional) — Further development.** Only if tensions need more work or framings remain underdeveloped.

- **Output.** The Synthesizer drafts the final document: a structured recon with competing framings, fully developed tensions, unexpected connections, and genuinely open questions — all in Obsidian-native markdown with wikilinks, callouts, and footnotes.

## Architecture

deep-recon uses **subagents** (Claude Code's Task tool), not agent teams. Each agent is
dispatched as an independent task that reports back to the orchestrator. Agents don't
communicate with each other directly — the orchestrator cross-pollinates findings between
rounds.

This is deliberate. The orchestrator's role between rounds — digesting the Synthesizer's
analysis, compiling settled claims, crafting tailored prompts for each agent — is an
interpretive step that shapes the next round's quality. Agent teams (experimental in Claude
Code 4.6) offer direct inter-agent messaging, but at the cost of deterministic control
over round structure and dispatch.

When agent teams exit experimental status, a hybrid approach — orchestrator-controlled
rounds with inter-agent dialogue within each round — could improve the Critic↔Explorer
and Synthesizer→all-agents communication flows.

## Modes

| Flag | Mode | Description |
|---|---|---|
| *(default)* | Interactive | Socratic — checks in between rounds for user steering |
| `--autonomous` | Autonomous | Runs all rounds, delivers finished document |
| *(default)* | Explore | Divergent — opens possibility space, ends with open questions |
| `--focus` | Focus | Convergent — narrows to one argument, ends with action plan |
| `--vault-only` | Vault-only | Skips web search, uses only vault content |
| `--pdfs` | PDF collection | Explorer downloads relevant PDFs to `<output_dir>/PDFs/` |

## Installation

Copy the `deep-recon` directory (with `agents/` and `templates/` subdirectories) into your `.claude/skills/` directory:

```
your-project/
└── .claude/
    └── skills/
        └── deep-recon/
            ├── SKILL.md
            ├── agents/
            │   ├── explorer.md
            │   ├── associator.md
            │   ├── critic.md
            │   └── synthesizer.md
            └── templates/
                └── brainstorm-output.md
```

Then add the skill to your `CLAUDE.md` so it appears in the skill list:

```markdown
### /deep-recon - Deep Reconnaissance
Run extended multi-agent reconnaissance sessions. Four specialized agents work in parallel
rounds to map a topic's territory from multiple angles.
```

## Usage

```
/deep-recon <topic or question>
```

Examples:
```
/deep-recon the relationship between infrastructure decay and political legitimacy
/deep-recon --autonomous --focus what makes network culture different from digital culture
/deep-recon --vault-only connections between my notes on sound art and landscape
```

You can also reference specific notes or folders as source material:

```
/deep-recon based on essays/network-culture.md, explore the current state of this argument
```

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with access to the Opus model (the Synthesizer uses Opus for integrative thinking; other agents use Sonnet)
- An Obsidian vault (the skill produces Obsidian-native markdown)
- Web search access (unless using `--vault-only`)

## Output

The skill produces an Obsidian-native markdown document saved to a `recon/` subdirectory, structured as:

- **Central Question** — the refined driving question
- **The Territory** — 3–5 fully developed framings, each standing on its own terms
- **Tensions** — productive frictions between framings, with full treatment of both sides
- **Unexpected Connections** — cross-domain links written as prose
- **Open Questions** — genuinely open, not rhetorical
- **Sources** — vault wikilinks and web references
- **Process Log** — mode, intention, round count, per-round summaries

Individual agent reports are saved alongside as reference material.

## License

MIT
