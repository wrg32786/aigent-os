---
title: Dead letter queue
tags: [concept]
---

# Dead letter queue

A holding area for messages that could not be processed after the allowed retries. Its real job is to stop one poisonous message from blocking everything behind it. A dead letter queue nobody reads is just a slower way of dropping data.
