"""Run actual installer functions without Docker or external requests."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from test_install_schedule import INSTALLER, run_installer


class InstallVersionTests(unittest.TestCase):
    def test_four_part_and_legacy_tags_survive_normalization(self):
        for value, expected in [('v1.3.208.0', 'v1.3.208.0'), ('v1.3.204.1', 'v1.3.204.1'), ('1.3.204.2-amd64', 'v1.3.204.2'),
                                ('v1.2.3-arm64', 'v1.2.3')]:
            with self.subTest(value=value):
                result = run_installer('tag=$(normalize_tag "$CASE"); is_release_tag "$tag" && printf "%s" "$tag"', extra_env={'CASE': value})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, expected)

    def test_invalid_tags_are_rejected(self):
        for value in ['v1.3.204.-1', 'v1.3.204.1.1', 'v1.3.204.1;cmd', 'v1.3.204.1-beta', '../tag']:
            with self.subTest(value=value):
                self.assertNotEqual(run_installer('is_release_tag "$CASE"', extra_env={'CASE': value}).returncode, 0)

    def test_cli_accepts_four_part_version_without_running_an_install(self):
        result = subprocess.run(['bash', str(INSTALLER), '--version', 'v1.3.208.0', '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('vX.Y.Z.N', result.stdout)

    def test_latest_uses_the_published_release_not_reserved_git_tags(self):
        result = run_installer('latest_release_tag', {'tag_name': 'v1.3.204.2'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'v1.3.204.2')
        result = run_installer('latest_release_tag', {}, mock='git() { echo UNPUBLISHED_TAG_FALLBACK >&2; return 1; }')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('UNPUBLISHED_TAG_FALLBACK', result.stderr)

    def test_changelog_ranges_compare_revision_numerically(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'CHANGELOG.md'
            log.write_text('# Changelog\n\n## 1.3.204.10 — 2026-10-21\n\n- tenth\n\n## 1.3.204.2 — 2026-10-21\n\n- second\n\n## 1.3.204.1 — 2026-10-21\n\n- first\n')
            result = run_installer('print_changelog_slice "$CHANGELOG" v1.3.204.2 v1.3.204.10', extra_env={'CHANGELOG': str(log)})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('- tenth', result.stdout)
            self.assertNotIn('- second', result.stdout)
            self.assertNotIn('- first', result.stdout)


if __name__ == '__main__':
    unittest.main()
