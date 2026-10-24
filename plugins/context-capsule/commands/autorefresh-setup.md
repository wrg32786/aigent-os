---
description: Explain how to get fully hands-off refresh (prints instructions only, installs nothing)
---

Print the following guidance to the user. Do not run any installer, do not edit settings files, do not download anything.

1. **What this plugin gives you.** Manual-trigger refresh: `/refresh` writes a capsule, you run `/clear`, and the SessionStart hook points the fresh session at the capsule. A PreCompact hook reports the capsule (or nudges `/capsule`) before auto-compact.
2. **What it cannot do.** A plugin is loaded by Claude Code, so it cannot launch Claude Code or type `/clear` for you. Fully hands-off refresh at a context threshold needs a runner that owns the terminal session. That runner is part of the full aigent-os install, not this plugin.
3. **Your settings (read-only check).** Look at the user's `~/.claude/settings.json` and project `.claude/settings.json` and tell them whether `idleCompaction` is set. The aigent-os runner expects `"idleCompaction": false`. Say what you found and that they can change it themselves; do not edit it.
4. **For hands-off refresh.** Point them to the aigent-os repository (https://github.com/wrg32786/aigent-os) and its INSTALL.md. When aigent-os is installed in a project, this plugin detects it and stays silent, so the two never double-fire.
