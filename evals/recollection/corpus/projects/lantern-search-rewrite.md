---
title: Lantern search rewrite
tags: [project]
---

# Lantern search rewrite

Replacing the hand rolled matcher with something that understands stemming and misspellings. The hard part is not ranking, it is that the old system silently dropped queries containing punctuation, and several saved reports depend on that bug.
