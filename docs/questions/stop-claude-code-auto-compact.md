---
title: "How do I stop Claude Code auto-compact and clear instead?"
description: "Use aigent-os to save a checkpoint, run /clear and resume, instead of letting Claude Code auto-compact."
---

# How do I stop Claude Code auto-compact and clear instead?

Let something else handle the context boundary before compaction kicks in. aigent-os watches context use, and at a threshold (80% by default) it saves a verified checkpoint file called a capsule, runs `/clear`, and resumes in a fresh session from that capsule. Its shipped settings also set `"idleCompaction": false`, so Claude Code's idle compaction can't replace that step.

## How aigent-os does it

Claude Code has a fixed context window. When it fills, your built-in options are auto-compact (the model summarizes the conversation and keeps going on the summary) or `/clear` (you start over and re-explain). aigent-os takes a third path, called Managed Auto-Refresh:

1. Context hits the threshold (`AIGENT_PRESSURE_THRESHOLD_PCT`, default 80).
2. It asks Claude to write a capsule: objective, what it's waiting on, next step.
3. It waits for the exact line `Capsule Complete, Ready For Clear` in Claude's own reply.
4. It sends exactly one `/clear` and checks that a fresh session started.
5. It tells the new session to load the capsule and carry on.

No acknowledgement, no clear. If a compaction happens anyway, a `PreCompact` hook first flushes the latest state into the capsule and hands the compactor pointers into the memory vault.

This isn't "better than compaction". It's a different trade-off: an explicit checkpoint you can read and a clean window, instead of a summary the model wrote.

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

## FAQ

### Can I turn off auto-compact in Claude Code?

aigent-os ships settings with idleCompaction set to false, and it refreshes the session at 80% context so compaction is not the path it relies on. If a compaction still happens, a PreCompact hook saves state first.

### Should I use /compact or /clear?

Use /compact when a summary is good enough. Use /clear when you want a clean window. aigent-os gives you the clean window of /clear without re-briefing by running save, clear and resume for you.

### Does the context-capsule plugin stop compaction?

No. The plugin is manual: you run /capsule or /refresh, then /clear yourself. A plugin can't type /clear for you. Hands-off refresh at a threshold needs the full aigent-os install.

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
      "name": "Can I turn off auto-compact in Claude Code?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "aigent-os ships settings with idleCompaction set to false, and it refreshes the session at 80% context so compaction is not the path it relies on. If a compaction still happens, a PreCompact hook saves state first."
      }
    },
    {
      "@type": "Question",
      "name": "Should I use /compact or /clear?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Use /compact when a summary is good enough. Use /clear when you want a clean window. aigent-os gives you the clean window of /clear without re-briefing by running save, clear and resume for you."
      }
    },
    {
      "@type": "Question",
      "name": "Does the context-capsule plugin stop compaction?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No. The plugin is manual: you run /capsule or /refresh, then /clear yourself. A plugin can't type /clear for you. Hands-off refresh at a threshold needs the full aigent-os install."
      }
    }
  ]
}
</script>
