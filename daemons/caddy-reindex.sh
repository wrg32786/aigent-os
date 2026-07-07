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

out_path.parent.mkdir(parents=True, exist_ok=True)
out_path.write_text(json.dumps(index, indent=2), encoding="utf-8")
print(f"[caddy-reindex] wrote {len(index)} skills to {out_path}")
PYEOF
