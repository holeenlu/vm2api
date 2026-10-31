import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "configure-docker-address-pools.py"
SPEC = importlib.util.spec_from_file_location("docker_address_pools", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class DockerAddressPoolTests(unittest.TestCase):
    def test_creates_pool_and_preserves_existing_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "daemon.json"
            path.write_text(json.dumps({"live-restore": True}) + "\n", encoding="utf-8")
            changed, backup = MODULE.configure(path, "10.200.0.0/16", 24)
            self.assertTrue(changed)
            self.assertIsNotNone(backup)
            self.assertEqual(json.loads(path.read_text()), {
                "live-restore": True,
                "default-address-pools": [{"base": "10.200.0.0/16", "size": 24}],
            })
            self.assertEqual(json.loads(Path(backup).read_text()), {"live-restore": True})

    def test_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "daemon.json"
            path.write_text(json.dumps({"default-address-pools": [{"base": "10.200.0.0/16", "size": 24}]}) + "\n")
            changed, backup = MODULE.configure(path, "10.200.0.0/16", 24)
            self.assertFalse(changed)
            self.assertIsNone(backup)

    def test_rejects_overlapping_pool(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "daemon.json"
            path.write_text(json.dumps({"default-address-pools": [{"base": "10.200.0.0/16", "size": 24}]}) + "\n")
            with self.assertRaisesRegex(ValueError, "overlaps"):
                MODULE.configure(path, "10.200.1.0/24", 28)

    def test_rejects_invalid_pool_size(self):
        with self.assertRaisesRegex(ValueError, "must be between"):
            MODULE.parse_pool("10.200.0.0/16", 12)


if __name__ == "__main__":
    unittest.main()
