# memory-heat

Computes per-note `heat_score` for the aigent-OS vault. Notes decay if unused, reinforce if touched. Pattern borrowed from [tinyhumansai/neocortex](https://github.com/tinyhumansai/neocortex).

See [`vault/concepts/Memory Decay Doctrine.md`](../../vault/concepts/Memory%20Decay%20Doctrine.md) for full doctrine.

## Usage

```bash
node daemons/memory-heat/compute-heat.js
```

Output: `vault/memory/HEAT_INDEX.json`

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AIGENT_VAULT_ROOT` | Two dirs up from this file (repo root) | Absolute path to your aigent-OS repo root |
| `AIGENT_JSONL_ROOT` | unset (skip session signal) | Claude Code project logs directory, e.g. `~/.claude/projects/<your-project-hash>`. When set, the script counts `Read` tool calls on vault paths as a reinforcement signal. |

## When it runs

- **On demand only** — heat is not wired to a session hook. (Earlier builds invoked it from a `/close` skill; `/close` and `/open` are retired, so run it yourself when you want a fresh prioritization signal.)
- **Manually** — run the command above any time after a big vault reorg or to test pin changes.

## Pinning

Edit `pinlist.json` to add paths (relative to vault root) that should never decay below the floor (50). These are constitutional notes: identity docs, authority matrices, standing rules.

You can also add `pin: critical` to a note's YAML frontmatter as an alternative.

## Tuning

Constants at the top of `compute-heat.js`:

- `HALF_LIFE_DAYS` — how fast untouched notes decay (default: 60 days)
- `LOOKBACK_DAYS` — session read window (default: 30 days)
- `PIN_FLOOR` — minimum score for pinned notes (default: 50)
- `WEIGHTS` — relative importance of each signal (reads 40%, backlinks 25%, mtime 20%, pin 15%)

Increase `HALF_LIFE_DAYS` if your vault is slower-moving; decrease if you want aggressive de-prioritization.
