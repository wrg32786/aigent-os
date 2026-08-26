---
title: Bulkhead isolation
tags: [concept]
---

# Bulkhead isolation

Borrowed from shipbuilding. Resources are carved into compartments so that exhausting one does not drain the others. A thread pool per dependency is the common form, so a single slow downstream cannot consume every worker and stall unrelated traffic.
