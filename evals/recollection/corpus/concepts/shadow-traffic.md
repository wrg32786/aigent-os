---
title: Shadow traffic
tags: [concept]
---

# Shadow traffic

Duplicating real requests to a new implementation whose responses are thrown away, purely to see how it behaves under genuine load and genuine input weirdness. Cheap safety, with one sharp edge: side effects must be disabled or the shadow becomes a second writer.
