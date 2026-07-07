---
title: API first not browser
tags: [feedback, operations, tools]
aliases: []
created: 2026-05-11
---

When a service has an API, use the API. Don't reach for browser-harness. Browser is for sites with no API. Apollo, Spotify, YouTube, Beehiiv — all have APIs. Use them.

Store API keys in `reference/api-keys.md` the moment they're created or shared. Don't bury them in daily logs or session transcripts where they get lost.

**Why:** Recurring loop: the operator gives a key, the key gets used once inline, buried in daily log, next session the AIgent can't find it, falls back to browser, fumbles, asks again. Wastes time and patience every time.

**How to apply:** 
1. First question for any external service task: "Do we have an API key in `reference/api-keys.md`?"
2. If yes, use the API directly with curl.
3. If no, check if the service has an API (most do). Ask the operator for a key once, save it immediately.
4. Browser-harness is the LAST resort, not the first instinct.

## Caddy hook

Trigger: any mention of Apollo, Spotify API, YouTube API, or other services where keys exist in reference/api-keys.md
Surface: check reference/api-keys.md for stored credentials before reaching for browser-harness.
