---
title: Eventual consistency
tags: [concept]
---

# Eventual consistency

A guarantee that replicas converge if updates stop, with no promise about what any single reader sees in the meantime. It is a perfectly good contract as long as the product surface is honest about it, and a source of nasty surprises when the interface implies otherwise.
