---
title: Write ahead log
tags: [concept]
---

# Write ahead log

Record the intention durably before mutating the structure, so a crash mid mutation can be replayed forward into a consistent state. Nearly every durable store has one under some name, and nearly every corruption story starts with someone bypassing it.
