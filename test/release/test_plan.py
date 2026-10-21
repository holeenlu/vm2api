import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_plan', Path(__file__).resolve().parents[2] / 'scripts/release/plan.py')
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)


class VersionPlanTests(unittest.TestCase):
    def test_first_and_second_release_share_upstream_prefix(self):
        self.assertEqual(plan.next_version('1.3.208', []), '1.3.208.0')
        self.assertEqual(plan.next_version('1.3.208', [{'tag_name': 'v1.3.208.0'}]), '1.3.208.1')

    def test_drafts_and_orphan_tags_reserve_revisions(self):
        releases = [{'tag_name': 'v1.3.208.1', 'draft': True}, {'tag_name': 'payload-2026.10.19'}]
        self.assertEqual(plan.next_version('1.3.208', releases, tags=['v1.3.208.2']), '1.3.208.3')

    def test_revision_is_numeric_after_nine(self):
        self.assertEqual(plan.next_version('1.3.208', [], tags=['v1.3.208.9', 'v1.3.208.10']), '1.3.208.11')

    def test_new_upstream_prefix_restarts_at_zero(self):
        releases = [{'tag_name': 'v1.3.208.99'}, {'tag_name': 'v1.9.0'}, {'tag_name': 'v1.3.209'}]
        self.assertEqual(plan.next_version('1.3.209', releases), '1.3.209.0')

    def test_zero_revision_is_reserved_by_draft_or_tag(self):
        self.assertEqual(plan.next_version('1.3.208', [{'tag_name': 'v1.3.208.0', 'draft': True}]), '1.3.208.1')
        self.assertEqual(plan.next_version('1.3.208', [], tags=['v1.3.208.0']), '1.3.208.1')

    def test_existing_revisions_are_not_reused_or_backfilled(self):
        self.assertEqual(plan.next_version('1.3.208', [], tags=['v1.3.208.2']), '1.3.208.3')

    def test_planned_version_validation_accepts_zero_and_rejects_malformed_values(self):
        self.assertEqual(plan.version_tuple('1.3.208.0'), (1, 3, 208, 0))
        for value in ['1.3.208', '1.3.208.-1', '1.3.208.01', '1.3.208.1.1', '1.3.208.1;cmd', '../v1']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                plan.version_tuple(value)

    def test_upstream_version_requires_three_numeric_parts(self):
        self.assertEqual(plan.upstream_version('1.3.208\n'), '1.3.208')
        for value in ['v1.3.208', '1.3.208-rc1', '1.3.208.0', 'payload-latest', '1.3.0208']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                plan.upstream_version(value)


class PlanExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cwd = Path.cwd()
        os.chdir(self.temp.name)
        Path('VERSION').write_text('1.3.203\n')
        Path('package.json').write_text(json.dumps({'name': 'tapmodels', 'private': True}))
        Path('package-lock.json').write_text(json.dumps({'name': 'tapmodels', 'lockfileVersion': 3, 'packages': {'': {'name': 'tapmodels'}}}))
        self.output = str(Path('github-output').resolve())
        self.commands = []
        self.upstream = '1.3.208\n'
        self.upstream_commit = 'a' * 40
        self.releases = []
        self.tags = []

    def tearDown(self):
        os.chdir(self.cwd)
        self.temp.cleanup()

    def run_command(self, *args):
        self.commands.append(args)
        if args == ('git', 'rev-parse', 'HEAD'):
            return 'release-commit' if any(c[:2] == ('git', 'commit') for c in self.commands) else 'source-commit'
        if args[:2] == ('gh', 'api'):
            if args[2] == 'repos/dofastted/vm2api/commits/main':
                return self.upstream_commit
            if args[2] == f'repos/dofastted/vm2api/contents/VERSION?ref={self.upstream_commit}':
                return base64.b64encode(self.upstream.encode()).decode()
            if '/releases?' in args[-1]:
                return json.dumps([self.releases])
            if '/tags?' in args[-1]:
                return json.dumps([self.tags])
            self.fail('Unexpected API endpoint ' + args[-1])
        return ''

    def execute(self, publish=False, repository='holeenlu/vm2api', run=None):
        env = {'GITHUB_REPOSITORY': repository, 'GITHUB_REF': 'refs/heads/main',
               'PUBLISH': str(publish).lower(), 'GITHUB_OUTPUT': self.output}
        with patch.dict(os.environ, env), patch.object(plan, 'run', side_effect=run or self.run_command):
            plan.main()
        return json.loads(Path('release-plan.json').read_text())

    def test_preview_uses_live_upstream_and_never_reserves_or_mutates_source(self):
        result = self.execute()
        self.assertEqual(result['tag'], 'v1.3.208.0')
        self.assertEqual(result['upstream_version'], '1.3.208')
        self.assertEqual(result['upstream_commit'], self.upstream_commit)
        self.assertEqual(result['commit'], 'source-commit')
        self.assertEqual(Path('VERSION').read_text(), '1.3.203\n')
        self.assertNotIn('version', json.loads(Path('package.json').read_text()))
        self.assertTrue(all(c[:2] in [('gh', 'api'), ('git', 'rev-parse')] for c in self.commands))
        self.assertIn('version=1.3.208.0\n', Path(self.output).read_text())

    def test_publication_reserves_exact_fork_tag_without_pushing_main(self):
        self.releases = [{'tag_name': 'v1.3.208.1', 'draft': True}]
        self.tags = [{'name': 'v1.3.208.2'}]
        result = self.execute(publish=True)
        self.assertEqual(result['tag'], 'v1.3.208.3')
        self.assertEqual(result['commit'], 'release-commit')
        self.assertEqual(Path('VERSION').read_text(), '1.3.208.3\n')
        push = [c for c in self.commands if c[:2] == ('git', 'push')]
        self.assertEqual(push, [('git', 'push', 'https://github.com/holeenlu/vm2api.git', 'refs/tags/v1.3.208.3:refs/tags/v1.3.208.3')])
        draft = next(c for c in self.commands if c[:3] == ('gh', 'release', 'create'))
        self.assertIn('--draft', draft)
        self.assertNotIn('version', json.loads(Path('package.json').read_text()))
        lock = json.loads(Path('package-lock.json').read_text())
        self.assertNotIn('version', lock)
        self.assertNotIn('version', lock['packages'][''])

    def test_stamp_cli_applies_planned_version_without_network_or_git_mutation(self):
        result = subprocess.run(['python3', str(Path(plan.__file__).resolve()), '--stamp-version', '1.3.208.0'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(Path('VERSION').read_text(), '1.3.208.0\n')
        self.assertNotIn('version', json.loads(Path('package.json').read_text()))
        self.assertFalse(Path('release-plan.json').exists())

    def test_first_publication_reserves_zero_without_manual_input(self):
        result = self.execute(publish=True)
        self.assertEqual(result['tag'], 'v1.3.208.0')
        self.assertEqual(Path('VERSION').read_text().strip(), '1.3.208.0')
        self.assertIn(('git', 'tag', 'v1.3.208.0'), self.commands)

    def test_obsolete_manual_override_cannot_change_automatic_version(self):
        with patch.dict(os.environ, {'RELEASE_VERSION': 'malformed-old-input'}):
            result = self.execute()
        self.assertEqual(result['version'], '1.3.208.0')

    def test_upstream_lookup_failure_does_not_guess_from_local_version(self):
        def fail(*args):
            if args[0:2] == ('gh', 'api') and args[2] == 'repos/dofastted/vm2api/commits/main':
                raise subprocess.CalledProcessError(1, args)
            return self.run_command(*args)
        with self.assertRaises(subprocess.CalledProcessError):
            self.execute(publish=True, run=fail)
        self.assertEqual(Path('VERSION').read_text(), '1.3.203\n')
        self.assertFalse(Path('release-plan.json').exists())

    def test_wrong_repository_is_rejected_before_any_command(self):
        with self.assertRaises(SystemExit):
            self.execute(publish=True, repository='dofastted/vm2api')
        self.assertFalse(self.commands)


if __name__ == '__main__':
    unittest.main()
