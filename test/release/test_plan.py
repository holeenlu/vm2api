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
        self.assertEqual(plan.upstream_version('1.4.025\n'), '1.4.025')
        for value in ['v1.3.208', '1.3.208-rc1', '1.3.208.0', 'payload-latest', '1.4.', '1.４.025']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                plan.upstream_version(value)

    def test_zero_padded_upstream_prefix_preserved_and_revisions_reserved(self):
        self.assertEqual(plan.next_version('1.4.025', []), '1.4.025.0')
        self.assertEqual(plan.next_version('1.4.025', [{'tag_name': 'v1.4.025.9', 'draft': True}],
                                           tags=['v1.4.025.10', 'v1.4.024.99']), '1.4.025.11')
        self.assertEqual(plan.version_tuple('1.4.025.0'), (1, 4, 25, 0))
        with self.assertRaises(ValueError):
            plan.version_tuple('1.4.025.01')


class PlanExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cwd = Path.cwd()
        os.chdir(self.temp.name)
        Path('VERSION').write_text('1.3.208\n')
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
        if args == ('git', 'show', '-s', '--format=%P', 'source-commit'):
            return self.upstream_commit
        if args == ('git', 'show', f'{self.upstream_commit}:VERSION'):
            return self.upstream.strip()
        if args[:2] == ('gh', 'api'):
            if args[2] == 'repos/dofastted/vm2api/commits/main':
                return self.upstream_commit
            if args[2] == f'repos/dofastted/vm2api/compare/{self.upstream_commit}...main':
                return 'ahead'
            if args[2] == f'repos/dofastted/vm2api/contents/VERSION?ref={self.upstream_commit}':
                return base64.b64encode(self.upstream.encode()).decode()
            if args[2].startswith('repos/holeenlu/vm2api/commits/v'):
                return 'source-commit'
            if '/releases?' in args[-1]:
                return json.dumps([self.releases])
            if '/tags?' in args[-1]:
                return json.dumps([self.tags])
            self.fail('Unexpected API endpoint ' + args[-1])
        return ''

    def execute(self, publish=False, repository='holeenlu/vm2api', run=None, automatic=False):
        env = {'GITHUB_REPOSITORY': repository, 'GITHUB_REF': 'refs/heads/main',
               'PUBLISH': str(publish).lower(), 'GITHUB_OUTPUT': self.output,
               'AUTOMATIC_RELEASE': str(automatic).lower()}
        with patch.dict(os.environ, env), patch.object(plan, 'run', side_effect=run or self.run_command):
            plan.main()
        return json.loads(Path('release-plan.json').read_text())

    def test_preview_uses_integrated_baseline_and_never_reserves_or_mutates_source(self):
        result = self.execute()
        self.assertEqual(result['tag'], 'v1.3.208.0')
        self.assertEqual(result['upstream_version'], '1.3.208')
        self.assertEqual(result['upstream_commit'], self.upstream_commit)
        self.assertEqual(result['commit'], 'source-commit')
        self.assertEqual(Path('VERSION').read_text(), '1.3.208\n')
        self.assertNotIn('version', json.loads(Path('package.json').read_text()))
        self.assertTrue(all(c[:2] in [('gh', 'api'), ('git', 'rev-parse'), ('git', 'merge-base'), ('git', 'show')] for c in self.commands))
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
        result = subprocess.run(['python3', str(Path(plan.__file__).resolve()), '--stamp-version', '1.4.025.0'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(Path('VERSION').read_text(), '1.4.025.0\n')
        self.assertNotIn('version', json.loads(Path('package.json').read_text()))
        self.assertFalse(Path('release-plan.json').exists())

    def test_first_publication_reserves_zero_without_manual_input(self):
        result = self.execute(publish=True)
        self.assertEqual(result['tag'], 'v1.3.208.0')
        self.assertEqual(Path('VERSION').read_text().strip(), '1.3.208.0')
        self.assertIn(('git', 'tag', 'v1.3.208.0'), self.commands)

    def test_zero_padded_upstream_plans_and_stamps_publication(self):
        self.upstream = '1.4.025\n'
        Path('VERSION').write_text(self.upstream)
        self.releases = [{'tag_name': 'v1.4.025.0', 'draft': True}]
        self.tags = [{'name': 'v1.4.025.1'}]
        result = self.execute(publish=True)
        self.assertEqual(result['version'], '1.4.025.2')
        self.assertEqual(result['upstream_version'], '1.4.025')
        self.assertEqual(Path('VERSION').read_text(), '1.4.025.2\n')
        self.assertIn(('git', 'tag', 'v1.4.025.2'), self.commands)
        self.assertIn('version=1.4.025.2\n', Path(self.output).read_text())

    def test_automatic_release_uses_exact_upstream_version_and_source(self):
        self.upstream = '1.4.025\n'
        Path('VERSION').write_text(self.upstream)
        result = self.execute(publish=True, automatic=True)
        self.assertEqual(result['tag'], 'v1.4.025')
        self.assertEqual(result['commit'], 'source-commit')
        self.assertEqual(Path('VERSION').read_text(), self.upstream)
        self.assertIn(('git', 'tag', 'v1.4.025'), self.commands)
        self.assertFalse(any(c[:2] in [('git', 'commit'), ('git', 'add')] for c in self.commands))

    def test_automatic_retry_reuses_matching_draft_and_tag(self):
        self.releases = [{'tag_name': 'v1.3.208', 'draft': True}]
        self.tags = [{'name': 'v1.3.208'}]
        self.execute(publish=True, automatic=True)
        self.assertFalse(any(c[:2] in [('git', 'tag'), ('git', 'push')] or c[:3] == ('gh', 'release', 'create') for c in self.commands))

    def test_automatic_tag_collision_cannot_overwrite_other_source(self):
        self.tags = [{'name': 'v1.3.208'}]
        def collision(*args):
            if args[:3] == ('gh', 'api', 'repos/holeenlu/vm2api/commits/v1.3.208'):
                return 'different-source'
            return self.run_command(*args)
        with self.assertRaisesRegex(ValueError, 'different source'):
            self.execute(publish=True, automatic=True, run=collision)
        self.assertFalse(any(c[:2] == ('git', 'push') for c in self.commands))

    def test_automatic_release_rejects_parent_outside_official_main(self):
        def diverged(*args):
            if args[:2] == ('gh', 'api') and '/compare/' in args[2]:
                return 'diverged'
            return self.run_command(*args)
        with self.assertRaisesRegex(ValueError, 'official upstream'):
            self.execute(publish=True, automatic=True, run=diverged)
        self.assertFalse(any(c[:2] == ('git', 'push') for c in self.commands))

    def test_published_automatic_version_is_skipped_without_remote_mutation(self):
        self.releases = [{'tag_name': 'v1.3.208', 'draft': False}]
        env = {'GITHUB_REPOSITORY': 'holeenlu/vm2api', 'GITHUB_REF': 'refs/heads/main',
               'PUBLISH': 'true', 'AUTOMATIC_RELEASE': 'true', 'GITHUB_OUTPUT': self.output}
        with patch.dict(os.environ, env), patch.object(plan, 'run', side_effect=self.run_command):
            plan.main()
        self.assertIn('release=false\n', Path(self.output).read_text())
        self.assertFalse(Path('release-plan.json').exists())
        self.assertFalse(any(c[:2] in [('git', 'push'), ('gh', 'release')] for c in self.commands))

    def test_obsolete_manual_override_cannot_change_automatic_version(self):
        with patch.dict(os.environ, {'RELEASE_VERSION': 'malformed-old-input'}):
            result = self.execute()
        self.assertEqual(result['version'], '1.3.208.0')

    def test_upstream_lookup_failure_does_not_guess_from_local_version(self):
        def fail(*args):
            if args[0:2] == ('gh', 'api') and '/contents/VERSION?' in args[2]:
                raise subprocess.CalledProcessError(1, args)
            return self.run_command(*args)
        with self.assertRaises(subprocess.CalledProcessError):
            self.execute(publish=True, run=fail)
        self.assertEqual(Path('VERSION').read_text(), '1.3.208\n')
        self.assertFalse(Path('release-plan.json').exists())

    def test_unintegrated_upstream_is_rejected_before_version_tag_or_release_mutation(self):
        def stale(*args):
            if args[:2] == ('git', 'merge-base'):
                raise subprocess.CalledProcessError(1, args)
            return self.run_command(*args)
        with self.assertRaisesRegex(ValueError, 'selected upstream baseline'):
            self.execute(publish=True, run=stale)
        self.assertEqual(Path('VERSION').read_text(), '1.3.208\n')
        self.assertFalse(any(c[:2] in [('git', 'commit'), ('git', 'tag'), ('git', 'push'), ('gh', 'release')] for c in self.commands))
        self.assertFalse(Path('release-plan.json').exists())

    def test_local_version_mismatch_is_rejected_before_publication(self):
        Path('VERSION').write_text('1.3.207\n')
        with self.assertRaisesRegex(ValueError, 'Source VERSION'):
            self.execute(publish=True)
        self.assertEqual(Path('VERSION').read_text(), '1.3.207\n')
        self.assertFalse(any(c[:2] == ('git', 'add') for c in self.commands))

    def test_real_graph_manual_release_uses_integrated_version_after_upstream_advances(self):
        def git(*args, **kwargs):
            return subprocess.check_output(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', *args], text=True, **kwargs).strip()
        git('init', '-q')
        git('add', 'VERSION')
        git('commit', '-qm', 'author base')
        author = git('rev-parse', 'HEAD')
        Path('custom.txt').write_text('customization')
        git('add', 'custom.txt')
        git('commit', '-qm', 'custom')
        source = git('rev-parse', 'HEAD')
        git('checkout', '-q', '--detach', author)
        Path('VERSION').write_text('1.3.209\n')
        git('add', 'VERSION')
        git('commit', '-qm', 'new upstream release')
        later_author = git('rev-parse', 'HEAD')
        git('checkout', '-q', '--detach', source)
        self.upstream_commit = author

        def actual_graph(*args):
            if args[0] == 'git' and args[1] in ('rev-parse', 'merge-base', 'show'):
                return git(*args[1:])
            if args[:3] == ('gh', 'api', 'repos/dofastted/vm2api/commits/main'):
                self.fail('Manual release must not select live upstream main')
            if args[:2] == ('gh', 'api') and '/contents/VERSION?' in args[2]:
                self.assertEqual(args[2], f'repos/dofastted/vm2api/contents/VERSION?ref={author}')
                return base64.b64encode(git('show', author + ':VERSION').encode()).decode()
            if args[:2] == ('gh', 'api') and '/compare/' in args[2]:
                self.assertEqual(git('merge-base', author, later_author), author)
                return 'ahead'
            return self.run_command(*args)
        result = self.execute(run=actual_graph)
        self.assertEqual(result['source_commit'], source)
        self.assertEqual(result['upstream_commit'], author)
        self.assertEqual(result['version'], '1.3.208.0')
        self.assertEqual(git('rev-parse', 'HEAD'), source)
        self.assertEqual(git('tag', '--list'), '')
        self.assertFalse(any(c[:2] in [('git', 'push'), ('gh', 'release')] for c in self.commands))

    def test_manual_publication_rejects_non_official_parent_before_mutation(self):
        def diverged(*args):
            if args[:2] == ('gh', 'api') and '/compare/' in args[2]:
                return 'diverged'
            return self.run_command(*args)
        with self.assertRaisesRegex(ValueError, 'official upstream'):
            self.execute(publish=True, run=diverged)
        self.assertFalse(any(c[:2] in [('git', 'commit'), ('git', 'tag'), ('git', 'push')] for c in self.commands))
        self.assertEqual(Path('VERSION').read_text(), '1.3.208\n')

    def test_release_rejects_root_or_multiple_parents(self):
        for parents in ['', self.upstream_commit + ' ' + 'b' * 40]:
            with self.subTest(parents=parents):
                def invalid_parent(*args):
                    if args == ('git', 'show', '-s', '--format=%P', 'source-commit'):
                        return parents
                    return self.run_command(*args)
                with self.assertRaisesRegex(ValueError, 'exactly one upstream parent'):
                    self.execute(publish=True, run=invalid_parent)
        self.assertFalse(any(c[:2] in [('git', 'commit'), ('git', 'tag'), ('git', 'push')] for c in self.commands))

    def test_wrong_repository_is_rejected_before_any_command(self):
        with self.assertRaises(SystemExit):
            self.execute(publish=True, repository='dofastted/vm2api')
        self.assertFalse(self.commands)


if __name__ == '__main__':
    unittest.main()
