"""The Python door to daemons/memory-root.cjs.

Every Python daemon that reads or writes memory asks here, and here asks the
one resolver. The resolver's CLI is tried first, with no shell in between, so
the base path reaches it byte for byte (a shell re-parse can strip quotes
from a path that carries one). When node is absent the shell door
``daemons/memory-root.sh`` answers instead: it refuses a declaration it
cannot resolve and applies only the resolver's default rule for an
undeclared root. This module carries NO rule of its own: it cannot name a
tree, so a Python daemon cannot disagree with a hook about where memory is.
A declaration that cannot be resolved raises ``MemoryRootError`` whose
message starts with ``MEMORY-ROOT:``; the daemon that called must stop
rather than touch a tree that may not be this seat's.
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


def _run(argv: list[str], base_text: str) -> subprocess.CompletedProcess[str]:
    # The resolver prints UTF-8; decoding with the console code page turns a
    # non-ASCII root into a different, nonexistent path returned as success.
    env = dict(os.environ, AIGENT_MEMORY_ROOT_BASE=base_text)
    return subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="strict", check=False, env=env)


def resolve_memory_root(
    base: str | os.PathLike[str],
    *,
    relative: bool = False,
    ledgers: bool = False,
) -> Path | str:
    """Resolve the memory root under ``base`` through the one resolver.

    ``ledgers=True`` asks for the skill-ledger location instead: the same
    tree when a root is declared, and on an undeclared install the
    pre-existing ``<base>/memory`` seed tree when it exists.

    Returns an absolute ``Path`` (or the root-relative string with
    ``relative=True``). Raises ``MemoryRootError`` when the resolver refuses
    or when nothing on this host can run it.
    """
    base_text = os.fspath(base)
    if not base_text.strip():
        raise MemoryRootError(f"{ERROR_TOKEN} a base directory is required to resolve the memory root")
    flags = (["--relative"] if relative else []) + (["--ledgers"] if ledgers else [])
    door = _HERE / "memory-root.sh"
    resolver = _HERE / "memory-root.cjs"
    attempts: list[list[str]] = []
    if shutil.which("node") and resolver.is_file():
        attempts.append(["node", str(resolver), "--root", base_text, *flags])
    if shutil.which("bash") and door.is_file():
        # The base travels in the environment, not in argv: an MSYS bash
        # re-parses argv as paths and can strip a quote from one, which turns
        # a declared root into a different, undeclared directory that then
        # resolves to the default tree with exit 0.
        attempts.append([
            "bash", "-c", '. "$1" && shift && aigent_memory_root "$AIGENT_MEMORY_ROOT_BASE" "$@"', "_", str(door), *flags,
        ])
    if not attempts:
        raise MemoryRootError(f"{ERROR_TOKEN} neither node nor bash is available to resolve the memory root under {base_text}")
    last_error = ""
    for argv in attempts:
        try:
            result = _run(argv, base_text)
        except (OSError, UnicodeDecodeError) as error:
            last_error = f"{ERROR_TOKEN} resolver could not run ({error})"
            continue
        if result.returncode == 0 and result.stdout.strip():
            value = result.stdout.strip().splitlines()[-1]
            return value if relative else Path(value)
        last_error = (result.stderr or result.stdout).strip() or f"{ERROR_TOKEN} resolver exited {result.returncode}"
        if last_error.startswith(ERROR_TOKEN):
            raise MemoryRootError(last_error)
    raise MemoryRootError(last_error if last_error.startswith(ERROR_TOKEN) else f"{ERROR_TOKEN} {last_error}")


def env_seat_base() -> Path | None:
    """The seat base the environment names, or None when it names nothing.

    ``AIGENT_STATE_HOME_DIR`` (the test and probe diversion lever) is honored
    first, as the JavaScript callers honor it. Then ``AIGENT_VAULT``, which the
    shipped settings set to the install root and which this daemon family has
    always preferred; it is taken as given, never trimmed, because an install
    whose root directory is itself named ``vault`` must keep its declaration
    (an ``AIGENT_VAULT`` that names a bare ``vault/`` directory still
    resolves, since the resolver's undeclared rule finds that directory's own
    ``memory/``). Then ``AIGENT_ROOT``.
    """
    for name in ("AIGENT_STATE_HOME_DIR", "AIGENT_VAULT", "AIGENT_ROOT"):
        value = os.environ.get(name)
        if value and value.strip():
            return Path(value)
    return None


def seat_base_from_env() -> Path:
    """The seat base for a harness-launched daemon: the environment's, else the historical home."""
    return env_seat_base() or Path(os.path.expanduser("~/.aigent"))


def memory_root_from_env(*, ledgers: bool = False) -> Path:
    """The seat's memory root (or skill-ledger root) for a harness-launched daemon."""
    return Path(resolve_memory_root(seat_base_from_env(), ledgers=ledgers))


def die(error: MemoryRootError) -> int:
    """Print the fault loudly and return the exit code a daemon should use."""
    print(str(error), file=sys.stderr)
    return 1
