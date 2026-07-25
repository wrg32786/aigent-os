#!/bin/bash
# caddy-reindex.sh - rebuild skill-index.json from vault catalog notes
# Reads vault/concepts/skills/*.md frontmatter and emits flat JSON index.
# Run manually after adding or editing skill catalog notes.
# The JSON index is what caddy.sh matches against at prompt submit time.

ROOT="${AIGENT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
VAULT_SKILLS="$ROOT/vault/concepts/skills"
INDEX_OUT="$ROOT/.claude/skill-index.json"

python3 - "$VAULT_SKILLS" "$INDEX_OUT" <<'PYEOF'
import sys, os, json, re
from pathlib import Path

vault_dir = Path(sys.argv[1])
out_path = Path(sys.argv[2])

if not vault_dir.exists():
    print(f"[caddy-reindex] {vault_dir} not found, skipping", file=sys.stderr)
    sys.exit(0)

def parse_frontmatter(text):
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
    if not m:
        return {}
    fm = {}
    for line in m.group(1).split("\n"):
        if ":" in line:
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip()
            if val.startswith("[") and val.endswith("]"):
                items = [s.strip().strip('"').strip("'") for s in val[1:-1].split(",")]
                fm[key] = [i for i in items if i]
            elif val:
                fm[key] = val.strip('"').strip("'")
    return fm

index = []
for md in sorted(vault_dir.glob("*.md")):
    if md.name.startswith("_") or md.name == "README.md":
        continue
    try:
        text = md.read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        name = fm.get("skill_name", md.stem)
        triggers = fm.get("triggers", [])
        why = fm.get("why", fm.get("description", ""))
        if isinstance(triggers, str):
            triggers = [t.strip() for t in triggers.split(",") if t.strip()]
        if triggers:
            index.append({
                "name": name,
                "triggers": triggers,
                "why": why,
            })
    except Exception as e:
        print(f"[caddy-reindex] skipped {md.name}: {e}", file=sys.stderr)

# Refuse to shrink the live index without an explicit override.
#
# A missing source directory is already handled above, but the dangerous case is a
# source directory that EXISTS and yields few or no skills: this script overwrites the
# index caddy.sh matches against at every prompt, so a partial harvest silently replaces
# a complete index with a smaller one and the router quietly stops finding most skills.
# Nothing downstream would report an error; skills would just stop being suggested.
#
# Set CADDY_REINDEX_FORCE=1 when a genuine shrink is intended.
existing = []
if out_path.exists():
    try:
        existing = json.loads(out_path.read_text(encoding="utf-8"))
    except Exception:
        existing = []

force = os.environ.get("CADDY_REINDEX_FORCE") == "1"
if existing and len(index) < len(existing) and not force:
    print(
        f"[caddy-reindex] REFUSING to write: would shrink the index from "
        f"{len(existing)} to {len(index)} skills.\n"
        f"[caddy-reindex] Source: {vault_dir}\n"
        f"[caddy-reindex] The router matches against this file, so a partial harvest "
        f"would silently stop most skills being suggested.\n"
        f"[caddy-reindex] If the shrink is intended, re-run with CADDY_REINDEX_FORCE=1.",
        file=sys.stderr,
    )
    sys.exit(1)

out_path.parent.mkdir(parents=True, exist_ok=True)
out_path.write_text(json.dumps(index, indent=2), encoding="utf-8")
print(f"[caddy-reindex] wrote {len(index)} skills to {out_path}")
PYEOF
