import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.release import guest_image_policy as policy


class GuestImagePolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (self.repo / "VERSION").write_text("1.4.029\n")
        (self.repo / "app.txt").write_text("base\n")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD")

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, text=True).strip()

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def test_manual_custom_release_reuses_images_when_sources_are_unchanged(self):
        (self.repo / "app.txt").write_text("custom\n")
        self.commit("custom change")
        result = policy.decision(
            self.repo,
            event_name="workflow_dispatch",
            publish="true",
            upstream_version="false",
            rebuild_requested="false",
        )
        self.assertFalse(result[0])
        self.assertIn("reuse existing", result[1])

    def test_manual_custom_release_rebuilds_when_guest_source_changed(self):
        (self.repo / "docker/kin-os/ubuntu-24.04").mkdir(parents=True)
        (self.repo / "docker/kin-os/ubuntu-24.04/Dockerfile").write_text("FROM ubuntu\n")
        self.commit("guest change")
        self.git("tag", "v1.4.029", self.base)
        result = policy.decision(
            self.repo,
            event_name="workflow_dispatch",
            publish="true",
            upstream_version="false",
            rebuild_requested="false",
        )
        self.assertTrue(result[0])
        self.assertIn("sources changed", result[1])

    def test_automatic_and_explicit_upstream_releases_rebuild(self):
        for event_name, upstream_version in [("push", "false"), ("workflow_dispatch", "true")]:
            with self.subTest(event_name=event_name):
                result = policy.decision(
                    self.repo,
                    event_name=event_name,
                    publish="true",
                    upstream_version=upstream_version,
                    rebuild_requested="false",
                )
                self.assertTrue(result[0])

    def test_build_verification_never_publishes_slot_images(self):
        result = policy.decision(
            self.repo,
            event_name="workflow_dispatch",
            publish="false",
            upstream_version="false",
            rebuild_requested="true",
        )
        self.assertFalse(result[0])
        self.assertIn("publish=false", result[1])


if __name__ == "__main__":
    unittest.main()
