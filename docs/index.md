---
title: "aigent-os: Claude Code harness and alternative to context compaction"
description: "Claude Code harness and alternative to context compaction: at 80% context it writes a verified capsule, runs /clear and resumes with persistent memory in git."
---

# aigent-os: Claude Code harness and alternative to context compaction

aigent-os is an open-source (MIT) Claude Code harness. When context reaches a threshold (80% by default) it saves a verified capsule, runs `/clear`, and resumes the work in a fresh session, with memory kept as markdown in git. It runs on your machine and has no server of its own.

## Questions

- [How do I stop Claude Code auto-compact and clear instead?](questions/stop-claude-code-auto-compact.md)
- [How do I make Claude Code run /clear automatically at a context threshold?](questions/claude-code-auto-clear.md)
- [How do I run long Claude Code sessions without losing context?](questions/long-running-claude-code-sessions.md)
- [How do I run multiple Claude Code agents with persistent memory?](questions/multiple-claude-code-agents-persistent-memory.md)
- [aigent-os vs claude-mem and other Claude Code memory tools: which should I use?](questions/aigent-os-vs-claude-mem.md)

## Install

```bash
git clone https://github.com/wrg32786/aigent-os.git && cd aigent-os && bash install.sh --dry-run
```

Or just the manual capsule plugin:

```
/plugin marketplace add wrg32786/aigent-os
/plugin install context-capsule@aigent-os
```

## More

- [Repo and README](https://github.com/wrg32786/aigent-os)
- [Getting started](getting-started.md)
- [Filesystem Standard](filesystem-standard.md)
- [context-capsule plugin](https://github.com/wrg32786/aigent-os/tree/master/plugins/context-capsule)
- [Releases](https://github.com/wrg32786/aigent-os/releases) (current: [v1.1.0](https://github.com/wrg32786/aigent-os/releases/tag/v1.1.0))
- [llms.txt](llms.txt)
