"""Count the two pending entry shapes in a MEMORY_CANDIDATES.md ledger."""

import re
import sys
from pathlib import Path


CAPSULE = re.compile(r"^##\s+\d{4}-\d{2}-\d{2}\b.*\bcapsule\b", re.I)
CLOSED = re.compile(
    r"\bbanked(?:\s+(?:in|as|to)\s+\S|\s*:|\s+\[\[)|\[(?:banked|ruled|discharged|skipped|superseded)\]"
    r"|(?:^|[.(\s])(?:ruled|discharged)\s*:", re.I
)


def table_cells(line: str) -> list[str]:
    row = line.lstrip(" ")
    if "|" not in row or line.startswith("    ") or row.startswith("\t"):
        return []
    body = row.rstrip().removeprefix("|").removesuffix("|")
    return [s.strip().lower() for s in re.split(r"(?<!\\)\|", body)]


def base_count(text: str) -> int:
    fence = ""

    def mask_line(match: re.Match) -> str:
        nonlocal fence
        body, ending = match.groups()
        marker = re.match(r"^[ \t]*(`{3,}|~{3,})", body)
        if not fence and marker:
            fence = marker[1]
            return " " * len(body) + ending
        if fence:
            close = re.fullmatch(r"[ \t]*(`{3,}|~{3,})[ \t]*", body)
            if close and close[1][0] == fence[0] and len(close[1]) >= len(fence):
                fence = ""
            return " " * len(body) + ending
        return match[0]

    masked = re.sub(r"([^\r\n]*)(\r\n|\n|\r|$)", mask_line, text)
    return len(re.findall(r"\|[ \t]*staged[ \t]*\|", masked, re.I | re.ASCII))


def structured_count(text: str) -> int:
    count = 0
    status_column = None
    capsule = False
    bullet = []
    fence = ""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        marker = re.match(r"^\s*(`{3,}|~{3,})", line)
        if fence:
            if line.strip().startswith(fence) and not line.strip().strip(fence[0]):
                fence = ""
            continue
        if marker:
            fence = marker[1]
            continue
        row = line.lstrip(" ")
        cells = table_cells(line)
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
        if "status" in cells and i + 1 < len(lines):
            separator = table_cells(lines[i + 1])
            if len(separator) == len(cells) and all(re.fullmatch(r":?-+:?", cell) for cell in separator):
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


def staged_count(text: str) -> int:
    # Keep the legacy staged-token count as a floor for the structured ledger count.
    return max(base_count(text), structured_count(text))


if __name__ == "__main__":
    print(staged_count(Path(sys.argv[1]).read_text(encoding="utf-8")))
