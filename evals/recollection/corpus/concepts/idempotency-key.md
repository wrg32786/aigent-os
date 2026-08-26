---
title: Idempotency key
tags: [concept]
---

# Idempotency key

A caller supplied identifier that lets a server recognise a retry of a request it has already carried out, and return the original outcome instead of doing the work twice. Without one, any network timeout on a write becomes a coin flip about whether the write happened.
