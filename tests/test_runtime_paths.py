import importlib.util
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "daemons" / "runtime" / "update-active-state.py"
spec = importlib.util.spec_from_file_location("runtime_state", MODULE_PATH)
runtime_state = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(runtime_state)


class RuntimePathTests(unittest.TestCase):
    def test_prefers_operational_vault_over_root_memory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "memory").mkdir()
            (root / "memory" / "SKILL_LEDGER.md").write_text("skills", encoding="utf-8")
            (root / "vault" / "memory").mkdir(parents=True)
            (root / "vault" / "memory" / "BODY_STATE.json").write_text("{}", encoding="utf-8")
            (root / "vault" / "memory" / "SESSION_LOG.md").write_text("# sessions", encoding="utf-8")
            with patch.dict(os.environ, {"AIGENT_ROOT": str(root), "AIGENT_VAULT": str(root)}, clear=False):
                self.assertEqual(runtime_state.resolve_vault_path(), (root / "vault").resolve())

    def test_accepts_explicit_vault_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            (vault / "memory").mkdir(parents=True)
            (vault / "memory" / "ACTIVE_PRIORITIES.md").write_text("# priorities", encoding="utf-8")
            with patch.dict(os.environ, {"AIGENT_VAULT": str(vault)}, clear=False):
                self.assertEqual(runtime_state.resolve_vault_path(), vault.resolve())

    def test_state_is_written_inside_vault(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            memory = vault / "memory"
            memory.mkdir(parents=True)
            (memory / "BODY_STATE.json").write_text(
                json.dumps({"state": {"context_pressure": "low"}}),
                encoding="utf-8",
            )
            state, events = runtime_state.compute_state(
                vault,
                datetime(2026, 7, 10, tzinfo=timezone.utc),
            )
            runtime_state.atomic_write_json(memory / "runtime" / "ACTIVE_STATE.json", state)
            saved = json.loads((memory / "runtime" / "ACTIVE_STATE.json").read_text(encoding="utf-8"))
            self.assertEqual(saved["vault_path"], str(vault))
            self.assertEqual(saved["mode"], "idle")
            self.assertTrue(any(event["event"] == "state_initialized" for event in events))


if __name__ == "__main__":
    unittest.main()
