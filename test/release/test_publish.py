import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_publish', Path(__file__).resolve().parents[2] / 'scripts/release/publish.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cwd = Path.cwd()
        os.chdir(self.temp.name)
        Path('release-assets').mkdir()
        Path('VERSION').write_text('1.3.208.0\n')
        Path('docs').mkdir()
        self.notes = '# 定制说明\n\n## 新增功能\n分组授权\n\n## 破坏性变更\n全新部署\n'
        Path('docs/CUSTOMIZATION_RELEASE_NOTES.md').write_text(self.notes)
        self.plan = {'publish': 'true', 'image': 'ghcr.io/holeenlu/tapmodels-gateway', 'tag': 'v1.3.208.0', 'version': '1.3.208.0', 'upstream_version': '1.3.208', 'commit': 'release-commit', 'source_commit': 'source-commit'}
        Path('release-plan.json').write_text(json.dumps(self.plan))
        for name in publish.REQUIRED:
            Path('release-assets', name).write_bytes(b'test asset')
        self.commands = []

    def tearDown(self):
        os.chdir(self.cwd)
        self.temp.cleanup()

    def run_command(self, *args):
        self.commands.append(args)
        if args[:2] == ('git', 'rev-parse'):
            return 'release-commit'
        if args[-1] == '{{json .Image}}':
            return json.dumps({'architecture': 'amd64', 'os': 'linux'})
        if args[-1] == '{{json .Manifest}}':
            return json.dumps({'digest': 'sha256:test'})
        return ''

    def run_publish(self, run=None):
        with patch.dict(os.environ, {'GITHUB_REPOSITORY': 'holeenlu/vm2api'}), patch.object(publish, 'run', side_effect=run or self.run_command):
            publish.main()

    def test_complete_amd64_release_attaches_all_checksums_before_publication(self):
        self.run_publish()
        checksum_lines = Path('release-assets/checksums.txt').read_text().splitlines()
        self.assertEqual(len(checksum_lines), len(publish.REQUIRED))
        manifest = json.loads(Path('release-assets/release-manifest.json').read_text())
        self.assertEqual(manifest['architectures'], ['amd64'])
        upload = next(i for i, cmd in enumerate(self.commands) if cmd[:3] == ('gh', 'release', 'upload'))
        public = next(i for i, cmd in enumerate(self.commands) if cmd[:3] == ('gh', 'release', 'edit'))
        self.assertLess(upload, public)
        self.assertIn('--draft=false', self.commands[public])
        self.assertIn('ghcr.io/holeenlu/tapmodels-gateway:latest', self.commands[-1])
        self.assertIn(self.notes.strip(), Path('release-notes.md').read_text())

    def test_release_notes_are_bounded_for_github_body_limit(self):
        Path('docs/CUSTOMIZATION_RELEASE_NOTES.md').write_text('x' * 130_000)
        self.run_publish()
        body = Path('release-notes.md').read_text()
        self.assertLessEqual(len(body), publish.MAX_RELEASE_BODY)
        self.assertIn('truncated', body)

    def test_release_notes_show_only_the_ten_most_recent_entries(self):
        notes = '# Full notes\n\n' + '\n\n'.join(
            f'## Entry {index}\nDetails {index}' for index in range(1, 13)
        )
        recent = publish.recent_release_notes(notes)
        self.assertIn('## Entry 1', recent)
        self.assertIn('## Entry 10', recent)
        self.assertNotIn('## Entry 11', recent)
        self.assertNotIn('## Entry 12', recent)

    def test_missing_notes_stops_before_remote_publication(self):
        Path('docs/CUSTOMIZATION_RELEASE_NOTES.md').unlink()
        with self.assertRaisesRegex(SystemExit, 'Missing customization release notes'):
            self.run_publish()
        self.assertEqual(self.commands, [('git', 'rev-parse', 'HEAD')])

    def test_repository_name_cannot_substitute_for_tapmodels_image(self):
        for image in ('ghcr.io/holeenlu/vm2api', 'ghcr.io/holeenlu/tapmodels'):
            with self.subTest(image=image):
                self.plan['image'] = image
                Path('release-plan.json').write_text(json.dumps(self.plan))
                with self.assertRaisesRegex(SystemExit, 'Invalid release plan'):
                    self.run_publish()
                self.assertEqual(self.commands, [])

    def test_dry_run_plan_cannot_publish(self):
        self.plan['publish'] = 'false'
        Path('release-plan.json').write_text(json.dumps(self.plan))
        with self.assertRaisesRegex(SystemExit, 'Invalid release plan'):
            self.run_publish()
        self.assertFalse(self.commands)

    def test_zero_padded_upstream_release_can_publish(self):
        self.plan.update(version='1.4.025.0', tag='v1.4.025.0', upstream_version='1.4.025')
        Path('VERSION').write_text('1.4.025.0\n')
        Path('release-plan.json').write_text(json.dumps(self.plan))
        self.run_publish()
        manifest = json.loads(Path('release-assets/release-manifest.json').read_text())
        self.assertEqual(manifest['version'], '1.4.025.0')
        self.assertTrue(any(c[:4] == ('gh', 'release', 'edit', 'v1.4.025.0') for c in self.commands))

    def test_exact_upstream_version_can_publish(self):
        self.plan.update(version='1.4.025', tag='v1.4.025', upstream_version='1.4.025')
        Path('VERSION').write_text('1.4.025\n')
        Path('release-plan.json').write_text(json.dumps(self.plan))
        self.run_publish()
        manifest = json.loads(Path('release-assets/release-manifest.json').read_text())
        self.assertEqual(manifest['version'], '1.4.025')

    def test_zero_padded_revision_is_rejected_before_publication(self):
        self.plan.update(version='1.4.025.01', tag='v1.4.025.01', upstream_version='1.4.025')
        Path('VERSION').write_text('1.4.025.01\n')
        Path('release-plan.json').write_text(json.dumps(self.plan))
        with self.assertRaisesRegex(SystemExit, 'Invalid release plan'):
            self.run_publish()
        self.assertFalse(self.commands)

    def test_missing_runtime_file_stops_before_any_remote_mutation(self):
        Path('release-assets/libc.so.6').unlink()
        with self.assertRaisesRegex(SystemExit, 'Missing asset: libc.so.6'):
            self.run_publish()
        self.assertEqual(self.commands, [('git', 'rev-parse', 'HEAD')])

    def test_missing_slot_gate_stops_before_any_remote_mutation(self):
        Path('release-assets/kin-slot-gate').unlink()
        with self.assertRaisesRegex(SystemExit, 'Missing asset: kin-slot-gate'):
            self.run_publish()
        self.assertEqual(self.commands, [('git', 'rev-parse', 'HEAD')])

    def test_mismatched_version_or_upstream_prefix_cannot_publish(self):
        for key, value in [('version', '1.3.208.1'), ('upstream_version', '1.3.203'), ('tag', 'v1.3.204')]:
            with self.subTest(key=key):
                changed = {**self.plan, key: value}
                Path('release-plan.json').write_text(json.dumps(changed))
                with self.assertRaisesRegex(SystemExit, 'Invalid release plan'):
                    self.run_publish()
                self.assertFalse(self.commands)

    def test_checkout_must_contain_the_planned_application_version(self):
        Path('VERSION').write_text('1.3.203\n')
        with self.assertRaisesRegex(SystemExit, 'Invalid release plan'):
            self.run_publish()
        self.assertFalse(self.commands)

    def test_arm64_image_cannot_publish(self):
        def wrong_arch(*args):
            result = self.run_command(*args)
            return result.replace('amd64', 'arm64') if args[-1] == '{{json .Image}}' else result
        with self.assertRaisesRegex(SystemExit, 'must be linux/amd64'):
            self.run_publish(wrong_arch)
        self.assertFalse(any(cmd[0] == 'gh' or cmd[1:4] == ('buildx', 'imagetools', 'create') for cmd in self.commands))


if __name__ == '__main__':
    unittest.main()
