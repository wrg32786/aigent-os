---
title: "How do I run long Claude Code sessions without losing context?"
description: "Keep one Claude Code session going for hours or days with aigent-os checkpoints, clear and resume, and memory in git."
---

# How do I run long Claude Code sessions without losing context?

Checkpoint before the window fills, clear, and reload the checkpoint, so the work survives each boundary. aigent-os automates that loop and keeps your notes, decisions and open threads as plain markdown in git, so a session can keep cycling through refreshes without you re-briefing it.

## How aigent-os does it

- **Capsules.** Each refresh writes a resume-ready capsule and the next session loads it. The capsule selector refuses a capsule that recorded no next step, so it won't resume into an empty checkpoint.
- **Memory vault.** A git-tracked markdown vault that every session reads at start and writes at checkpoints: daily notes, decisions, open threads and capsules, plus local semantic search. You can open, diff and roll back what your agent remembers.
- **Vault sync.** When a capsule cycle closes, memory is committed, and pushed only to a destination you've approved in `aigent.vaultSyncPushUrl` (see `docs/vault-sync.md`). Point it at a private repo.
- **Time-aware notes.** A note can carry a validity window. Once it ends, search ranks it below current notes instead of deleting it.
- **Memory guards.** A size budget on always-loaded memory, and memory that tries to give instructions is held for review.

Resuming isn't blind trust either: the capsule is treated as reference, and live state wins on resume.

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
- The capsule's "Done" section can hold unverified claims from the agent ([#80](https://github.com/wrg32786/aigent-os/issues/80)).
- There's no record of outside side effects (an email sent, a deploy started) across a refresh yet ([#81](https://github.com/wrg32786/aigent-os/issues/81)).

## FAQ

### Can Claude Code work on one task for hours?

That is what aigent-os is built for: one long-running session that keeps cycling through refreshes. The public evidence is 11 of 11 cycles on one machine, which is not a reliability guarantee.

### How do I make Claude Code remember things between sessions?

aigent-os adds a git-tracked markdown vault that every session reads at start and writes at checkpoints, on top of Claude Code's own CLAUDE.md and auto memory.

### Does my data leave my machine?

aigent-os has no server. Your vault is local files and semantic search runs locally. Claude Code still sends your conversation to Anthropic, and vault sync pushes memory commits to the remote you approved.

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
      "name": "Can Claude Code work on one task for hours?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "That is what aigent-os is built for: one long-running session that keeps cycling through refreshes. The public evidence is 11 of 11 cycles on one machine, which is not a reliability guarantee."
      }
    },
    {
      "@type": "Question",
      "name": "How do I make Claude Code remember things between sessions?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "aigent-os adds a git-tracked markdown vault that every session reads at start and writes at checkpoints, on top of Claude Code's own CLAUDE.md and auto memory."
      }
    },
    {
      "@type": "Question",
      "name": "Does my data leave my machine?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "aigent-os has no server. Your vault is local files and semantic search runs locally. Claude Code still sends your conversation to Anthropic, and vault sync pushes memory commits to the remote you approved."
      }
    }
  ]
}
</script>
