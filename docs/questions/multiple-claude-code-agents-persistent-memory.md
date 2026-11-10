---
title: "How do I run multiple Claude Code agents with persistent memory?"
description: "Run several aigent-os seats, each with its own memory vault and capsules, plus nine named specialist sub-agents."
---

# How do I run multiple Claude Code agents with persistent memory?

Give each agent its own install, its own memory and its own checkpoints. In aigent-os each seat has its own memory vault and its own capsules, and the maintainers run four seats (Titus, Pheme, Davinci and Metis) on one business, The AIgent newsletter.

## How aigent-os does it

- **Seats.** One install is one seat: one long-running Claude Code session with its own vault and capsules. Run more seats for more agents. See [Creating agents](../creating-agents.md).
- **Specialist sub-agents.** Inside a seat there are nine named agents: a builder, a read-only scout, a researcher, a design spec writer, a memory architect, a critic, a vault custodian, an architecture reviewer and a prompt writer, each with a fixed model tier and tool set.
- **Model tier check.** A `PreToolUse` hook checks every dispatch against the agent's declared tier. It warns by default; `AIGENT_MODEL_GUARD=enforce` blocks.
- **Teams.** There's written guidance on when to run a standing team, a one-shot fan-out or a solo agent. That's guidance only, no code.
- **Codex adapter.** Routes one bounded, mechanical task type to `codex exec` and writes a diff for review. It never commits or pushes.

Running four seats is operating experience, not a measured result. The README does not claim aigent-os grew the newsletter or cut operator effort.

## Install

Full install (needs Claude Code, Node.js 18+ with npm, and bash; on Windows use Git Bash):

```bash
git clone https://github.com/wrg32786/aigent-os.git && cd aigent-os && bash install.sh --dry-run
```

The dry run prints the planned changes and writes nothing. When it looks right, run `bash install.sh`, open a new terminal and run `aigent`.

Just want the manual capsule commands? Install the context-capsule plugin inside Claude Code:

```
/plugin marketplace add wrg32786/aigent-os
/plugin install context-capsule@aigent-os
```

## Limits

- The public evidence is 11 of 11 refresh cycles on one Windows seat, in one live run during v1.1.0-rc.1 testing. That is single-seat evidence, not a reliability claim, and not a claim that this beats compaction.
- The managed runner can still miss a permission dialog and answer it ([#104](https://github.com/wrg32786/aigent-os/issues/104)). Until the fix lands, don't run it unattended on a seat that can hit permission prompts.
- A seat launched from inside another Claude Code session can lose its transcript ([#98](https://github.com/wrg32786/aigent-os/issues/98)). Launch seats from a plain terminal.
- Scrolling the seat window during a refresh sends stray input ([#99](https://github.com/wrg32786/aigent-os/issues/99)).
- macOS has the least live mileage with the managed runner.

Full list: the Known limits section of the [v1.2.0 release notes](https://github.com/wrg32786/aigent-os/releases/tag/v1.2.0).
- The fleet-band and fleet-delivery mods (status line, message delivery into an idle session) are an opt-in pilot on master, not in a release, and delivery needs a message room and job source that aren't in the public repo. fleet-delivery can type into a seat during a refresh ([#105](https://github.com/wrg32786/aigent-os/issues/105)).

## FAQ

### Can I run Claude Code as a multi-agent system with separate memory?

Yes. Each aigent-os seat has its own memory vault and capsules. The maintainers run four seats on one business.

### Does it work with Codex or other models?

Claude Code is the host. A Codex adapter routes one bounded task class to codex exec, review gated and never auto merged. Other CLIs are on the roadmap, not shipped.

### Is it free?

aigent-os is free and MIT licensed. You pay for Claude Code as usual, and each refresh uses some tokens to write and read the capsule.

## More

- Repo and full README: [https://github.com/wrg32786/aigent-os](https://github.com/wrg32786/aigent-os)
- [All question pages](../index.md)
- [Releases](https://github.com/wrg32786/aigent-os/releases)

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Can I run Claude Code as a multi-agent system with separate memory?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes. Each aigent-os seat has its own memory vault and capsules. The maintainers run four seats on one business."
      }
    },
    {
      "@type": "Question",
      "name": "Does it work with Codex or other models?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Claude Code is the host. A Codex adapter routes one bounded task class to codex exec, review gated and never auto merged. Other CLIs are on the roadmap, not shipped."
      }
    },
    {
      "@type": "Question",
      "name": "Is it free?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "aigent-os is free and MIT licensed. You pay for Claude Code as usual, and each refresh uses some tokens to write and read the capsule."
      }
    }
  ]
}
</script>
