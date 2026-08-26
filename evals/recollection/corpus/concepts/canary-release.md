---
title: Canary release
tags: [concept]
---

# Canary release

Sending a small slice of live traffic to a new build while the rest stays on the old one, then widening only if the slice behaves. The value is entirely in the comparison: without a control group running at the same time, you are just deploying slowly.
