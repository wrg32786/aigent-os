---
title: Back pressure
tags: [concept]
---

# Back pressure

A signal travelling upstream that tells a producer to slow down because the consumer cannot keep pace. A pipeline without it does not fail gracefully, it fails by growing a queue until memory runs out, which looks fine on every dashboard until the moment it does not.
