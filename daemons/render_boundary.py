"""Shared rendering-boundary readers for production Python daemons."""

from __future__ import annotations

import json
import re
from typing import Any


__all__ = [
    "body_section",
    "capsule_value",
    "collapse_data",
    "collapse_line_breaking",
    "inert",
    "scalar",
    "unsafeRawBodySection",
    "unsafeRawCapsuleParts",
    "unsafeRawCapsuleValue",
    "unsafeRawScalar",
]


_LINE_BREAKING = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")
_FRONTMATTER = re.compile(
    r"^\ufeff?---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)",
    re.DOTALL,
)


def _require_reason(reason: str, accessor: str) -> None:
    if not isinstance(reason, str) or not reason.strip():
        raise TypeError(f"{accessor} requires a non-empty reason string")


def collapse_line_breaking(value: Any) -> str:
    return _LINE_BREAKING.sub(" ", str("" if value is None else value))


def collapse_data(value: Any) -> Any:
    if isinstance(value, str):
        return collapse_line_breaking(value)
    if isinstance(value, list):
        return [collapse_data(item) for item in value]
    if isinstance(value, tuple):
        return tuple(collapse_data(item) for item in value)
    if isinstance(value, dict):
        return {key: collapse_data(item) for key, item in value.items()}
    return value


def inert(value: Any, maximum: int = 500) -> str:
    rendered = re.sub(r"[ \t]+", " ", collapse_line_breaking(value)).strip()
    if len(rendered) > maximum:
        rendered = f"{rendered[:maximum]}…[+{len(rendered) - maximum} chars]"
    return json.dumps(rendered, ensure_ascii=True)


def _frontmatter(text: str) -> str | None:
    match = _FRONTMATTER.match(str(text))
    return match.group(1) if match else None


def _raw_scalar_token(text: str, key: str) -> str | None:
    frontmatter = _frontmatter(text)
    if frontmatter is None:
        return None
    match = re.search(
        rf"^{re.escape(str(key))}:[ \t]*(.*)$",
        frontmatter,
        re.MULTILINE,
    )
    return match.group(1).strip() if match else None


def _decode_scalar(raw: str) -> str:
    value = raw.strip()
    if value.startswith('"') and value.endswith('"'):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, str):
                return parsed
        except (json.JSONDecodeError, TypeError):
            return value[1:-1]
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    if value.startswith("#"):
        return ""
    return re.sub(r"\s+#.*$", "", value).strip()


def unsafeRawScalar(text: str, key: str, reason: str) -> str | None:
    _require_reason(reason, "unsafeRawScalar")
    token = _raw_scalar_token(text, key)
    return _decode_scalar(token) if token is not None else None


def scalar(text: str, key: str) -> str | None:
    value = unsafeRawScalar(
        text,
        key,
        "the safe scalar reader collapses line-breaking characters before returning",
    )
    return collapse_line_breaking(value) if value is not None else None


def unsafeRawBodySection(text: str, key: str, reason: str) -> str | None:
    _require_reason(reason, "unsafeRawBodySection")
    heading = re.escape(str(key)).replace("_", "[ _]")
    source = str(text)
    frontmatter = _FRONTMATTER.match(source)
    body = source[frontmatter.end() :] if frontmatter else source
    match = re.search(
        rf"^#{{1,6}}[ \t]+{heading}[ \t]*\r?\n"
        rf"(.*?)(?=^#{{1,6}}[ \t]|\Z)",
        body,
        re.MULTILINE | re.IGNORECASE | re.DOTALL,
    )
    value = match.group(1).strip() if match else ""
    return value or None


def body_section(text: str, key: str) -> str | None:
    value = unsafeRawBodySection(
        text,
        key,
        "the safe body reader collapses multiline body content before returning",
    )
    return collapse_line_breaking(value) if value is not None else None


def unsafeRawCapsuleValue(text: str, key: str, reason: str) -> str | None:
    _require_reason(reason, "unsafeRawCapsuleValue")
    return unsafeRawScalar(text, key, reason) or unsafeRawBodySection(
        text,
        key,
        reason,
    )


def capsule_value(text: str, key: str) -> str | None:
    return scalar(text, key) or body_section(text, key)


def unsafeRawCapsuleParts(
    text: str,
    reason: str,
) -> tuple[dict[str, str] | None, str]:
    _require_reason(reason, "unsafeRawCapsuleParts")
    match = _FRONTMATTER.match(str(text))
    if not match:
        return None, str(text)
    fields: dict[str, str] = {}
    # Only physical CR/LF boundaries create YAML fields. str.splitlines()
    # treats U+0085/U+2028/U+2029 as lines too and could materialize a hidden
    # field when a raw-preserving transformer writes the mapping back out.
    for line in re.split(r"\r\n|\n|\r", match.group(1)):
        if ":" in line and not line.startswith((" ", "\t")):
            key, _, value = line.partition(":")
            fields[key.strip()] = value.strip()
    return fields, str(text)[match.end() :]
