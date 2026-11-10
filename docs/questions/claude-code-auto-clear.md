---
title: "How do I make Claude Code run /clear automatically at a context threshold?"
description: "aigent-os Managed Auto-Refresh runs /clear for you at a context threshold, after saving a verified capsule."
---

# How do I make Claude Code run /clear automatically at a context threshold?

Claude Code itself only compacts automatically; `/clear` is manual. aigent-os adds the missing loop: at a threshold (80% by default) it gets a capsule and an exact acknowledgement from Claude, sends one `/clear`, waits for the new session's SessionStart receipt, and resumes from the capsule.

## How aigent-os does it

The `aigent` launcher runs Claude Code under a local runner (`daemons/pty-runner.mjs`, using `node-pty`). Each piece has one job:

- `daemons/ctx-telemetry.mjs` records the current context percentage.
- `skills/context-capsule/SKILL.md` writes and checks the capsule, then prints the exact acknowledgement line.
- `daemons/auto-clear-transport.mjs` holds the one-cycle authorization, so one acknowledgement buys at most one clear.
- `daemons/boot-receipt.mjs` and `daemons/sessionstart-reinject.mjs` confirm the fresh session.
- `daemons/resume-verb.mjs` loads the newest valid capsule.

The rules are strict on purpose. The acknowledgement has to be an exact line in a text block of Claude's own reply, so talking about clearing doesn't count. An acknowledgement only covers its own cycle. If operator input interrupts a prepared clear, the runner stops at `HOLD:clear-stalled-after-ack` with a visible notice instead of guessing. There's no automatic retry.

Change the threshold with `AIGENT_PRESSURE_THRESHOLD_PCT`. Turn automatic input off per seat with `AUTO_CLEAR_OFF=1` or the `runtime/auto-clear-off` marker. If `node-pty` can't load (or you install with `--no-deps`), Claude still starts and the launcher tells you automatic clear is unavailable.

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

### Is there a Claude Code auto clear setting?

Not in Claude Code itself; it only compacts automatically. aigent-os adds an auto clear loop: capsule, exact acknowledgement, one /clear, fresh session check, resume.

### What threshold does it use?

80% by default, configurable with the AIGENT_PRESSURE_THRESHOLD_PCT environment variable.

### What if Claude never confirms the capsule?

Then there is no clear. No acknowledgement means no clear, and one acknowledgement buys one clear.

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
      "name": "Is there a Claude Code auto clear setting?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Not in Claude Code itself; it only compacts automatically. aigent-os adds an auto clear loop: capsule, exact acknowledgement, one /clear, fresh session check, resume."
      }
    },
    {
      "@type": "Question",
      "name": "What threshold does it use?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "80% by default, configurable with the AIGENT_PRESSURE_THRESHOLD_PCT environment variable."
      }
    },
    {
      "@type": "Question",
      "name": "What if Claude never confirms the capsule?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Then there is no clear. No acknowledgement means no clear, and one acknowledgement buys one clear."
      }
    }
  ]
}
</script>
