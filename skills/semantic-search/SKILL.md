---
name: semantic-search
description: Search vault notes by meaning using local embeddings
trigger: /search
---

# Vault Semantic Search

Search the Obsidian vault by meaning, not just keywords. Uses local `all-MiniLM-L6-v2` model — no API calls, no data leaves your machine.

## Usage

```bash
# Search by meaning
node daemons/semantic-search/search-vault.js "your query here"

# Re-index (run after significant vault changes)
node daemons/semantic-search/embed-vault.js

# Re-index only changed files
node daemons/semantic-search/embed-vault.js --changed-only
```

## Setup

```bash
cd daemons/semantic-search && npm install
node embed-vault.js  # Initial index (~30 seconds)
```
