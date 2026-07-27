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

## Confidential-class deny list

Both `embed-vault.js` and `search-vault.js` read `daemons/semantic-search/index-deny.json` before doing anything else, and refuse to run (fail-closed, non-zero exit) if it's missing or malformed — an index or a search you can't confirm is filtered is worse than no index at all. It ships with an empty `deny_prefixes` array, so a fresh install builds a full index by default; add your own vault-relative path prefixes (case-insensitive, works with `/` or `\`) the same session any confidential or under-NDA material enters your vault. `index-deny.example.json` shows the pattern with illustrative placeholder paths. The deny check runs twice — once when the index is built, and again on every search — so a stale `embeddings.json` built before a prefix was added still can't leak a denied path.
