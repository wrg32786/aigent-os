---
title: Browser harness - just connect
tags: [feedback, browser-harness, operations]
aliases: []
created: 2026-05-11
---

Don't ask the operator to launch Chrome or close/reopen with debug flags. The browser-harness daemon connects to whatever Chrome is already running. Check `netstat` for an existing CDP port (9222) first — it's almost always already there. agents use it all day without intervention.

**Why:** The harness skill doc already says `ensure_daemon()` auto-starts. Asking the operator to restart Chrome is the kind of unnecessary friction that wastes time and breaks flow.

**How to apply:** Before any browser-harness task: `netstat -ano | grep 9222`. If listening, just run. If not, launch Chrome via PowerShell silently. Never ask the operator to do it.
