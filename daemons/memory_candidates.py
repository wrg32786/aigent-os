"""Count the two pending entry shapes in a MEMORY_CANDIDATES.md ledger."""

import re
import sys
from pathlib import Path


CAPSULE = re.compile(r"^##\s+\d{4}-\d{2}-\d{2}\b.*\bcapsule\b", re.I)
CLOSED = re.compile(
    r"\bbanked(?:\s+(?:in|as|to)\s+\S|\s*:|\s+\[\[)|\[(?:banked|ruled|discharged|skipped|superseded)\]"
    r"|(?:^|[.(\s])(?:ruled|discharged)\s*:", re.I
)


def staged_count(text: str) -> int:
    count = 0
    status_column = None
    capsule = False
    bullet = []
    fence = ""
    for line in text.splitlines():
        marker = re.match(r"^\s*(`{3,}|~{3,})", line)
        if fence:
            if line.strip().startswith(fence) and not line.strip().strip(fence[0]):
                fence = ""
            continue
        if marker:
            fence = marker[1]
            continue
        row = line.lstrip(" ")
        cells = []
        if "|" in row and not line.startswith("    ") and not row.startswith("\t"):
            body = row.rstrip().removeprefix("|").removesuffix("|")
            cells = [s.strip().lower() for s in re.split(r"(?<!\\)\|", body)]
        if cells and (row.startswith("|") or "status" in cells or status_column is not None):
            line = row
        if bullet and (line.startswith((" ", "\t")) or not line.strip()):
            bullet.append(line.strip())
            continue
        if bullet:
            count += CLOSED.search(" ".join(bullet)) is None
            bullet = []
        if re.match(r"^#{1,2}(?:\s|$)", line):
            capsule = bool(CAPSULE.match(line))
        if capsule and re.match(r"^[-*+] ", line):
            bullet = [line[2:]]
        if not cells:
            status_column = None
            continue
        if "status" in cells and (status_column is None or "source phrase" in cells):
            status_column = cells.index("status")
            continue
        column = status_column
        # Capture can append a canonical eight-cell row after a prose section.
        if column is None and len(cells) == 8 and re.fullmatch(r"\d{4}-\d{2}-\d{2}", cells[0]):
            column = 5
        if column is not None and column < len(cells):
            count += cells[column] in ("staged", "unscanned")
    if bullet and not CLOSED.search(" ".join(bullet)):
        count += 1
    return count


if __name__ == "__main__":
    print(staged_count(Path(sys.argv[1]).read_text(encoding="utf-8")))
