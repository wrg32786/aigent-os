---
title: Circuit breaker
tags: [concept]
---

# Circuit breaker

A wrapper that stops calling a failing dependency for a while, fails fast instead, and then lets a trickle through to test recovery. It protects the caller more than the callee: without it, every worker sits blocked on calls that were never going to succeed.
