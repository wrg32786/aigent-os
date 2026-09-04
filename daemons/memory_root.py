"""The Python door to daemons/memory-root.cjs.

Every Python daemon that reads or writes memory asks here, and here asks the
one resolver: the shell door ``daemons/memory-root.sh`` (which delegates to
``memory-root.cjs`` when node is present and otherwise applies only the
resolver's default rule for an undeclared root), or the resolver's CLI
directly when bash is not available. This module carries NO rule of its own:
it cannot name a tree, so a Python daemon cannot disagree with a hook about
where memory is. A declaration that cannot be resolved raises
``MemoryRootError`` whose message starts with ``MEMORY-ROOT:``; the daemon
that called must stop rather than touch a tree that may not be this seat's.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ERROR_TOKEN = "MEMORY-ROOT:"
_HERE = Path(__file__).resolve().parent


class MemoryRootError(RuntimeError):
    """A declared memory root that could not be resolved. Message carries the token."""


def _run(argv: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, capture_output=True, text=True, check=False)


def resolve_memory_root(base: str | os.PathLike[str], *, relative: bool = False) -> Path | str:
    """Resolve the memory root under ``base`` through the one resolver.

    Returns an absolute ``Path`` (or the root-relative string with
    ``relative=True``). Raises ``MemoryRootError`` when the resolver refuses
    or when nothing on this host can run it.
    """
    base_text = os.fspath(base)
    if not base_text.strip():
        raise MemoryRootError(f"{ERROR_TOKEN} a base directory is required to resolve the memory root")
    door = _HERE / "memory-root.sh"
    resolver = _HERE / "memory-root.cjs"
    attempts: list[list[str]] = []
    if shutil.which("bash") and door.is_file():
        args = ["aigent_memory_root", base_text] + (["--relative"] if relative else [])
        attempts.append([
            "bash", "-c", '. "$1" && shift && aigent_memory_root "$@"', "_", str(door), *args[1:],
        ])
    if shutil.which("node") and resolver.is_file():
        attempts.append(["node", str(resolver), "--root", base_text] + (["--relative"] if relative else []))
    if not attempts:
        raise MemoryRootError(f"{ERROR_TOKEN} neither bash nor node is available to resolve the memory root under {base_text}")
    last_error = ""
    for argv in attempts:
        try:
            result = _run(argv)
        except OSError as error:  # the binary vanished between which() and run()
            last_error = f"{ERROR_TOKEN} resolver could not start ({error})"
            continue
        if result.returncode == 0 and result.stdout.strip():
            value = result.stdout.strip().splitlines()[-1]
            return value if relative else Path(value)
        last_error = (result.stderr or result.stdout).strip() or f"{ERROR_TOKEN} resolver exited {result.returncode}"
        if last_error.startswith(ERROR_TOKEN):
            raise MemoryRootError(last_error)
    raise MemoryRootError(last_error if last_error.startswith(ERROR_TOKEN) else f"{ERROR_TOKEN} {last_error}")


def memory_root_from_env() -> Path:
    """The seat's memory root for a daemon launched by the harness.

    ``AIGENT_STATE_HOME_DIR`` (the test and probe diversion lever) is honored
    first, exactly as the JavaScript callers honor it, then ``AIGENT_ROOT``,
    then ``AIGENT_VAULT``, then the historical ``~/.aigent`` home.
    """
    for name in ("AIGENT_STATE_HOME_DIR", "AIGENT_ROOT", "AIGENT_VAULT"):
        value = os.environ.get(name)
        if value and value.strip():
            return Path(resolve_memory_root(value))
    return Path(resolve_memory_root(os.path.expanduser("~/.aigent")))


def die(error: MemoryRootError) -> int:
    """Print the fault loudly and return the exit code a daemon should use."""
    print(str(error), file=sys.stderr)
    return 1
