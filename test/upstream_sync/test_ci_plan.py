import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('ci_plan', ROOT / 'scripts/upstream-sync/ci_plan.py')
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class SelectionTests(unittest.TestCase):
    def test_path_selection(self):
        for paths, jobs in [
            (['docs/BUILD.md', 'AGENTS.md'], set()),
            (['web/src/main.tsx'], {'web'}),
            (['src/lib/admin/panel-acl.mjs'], {'unit', 'contracts'}),
            (['test/unit/pricing.test.mjs'], {'unit'}),
            (['test/e2e/relay-operations.e2e.test.mjs'], {'unit', 'contracts'}),
            (['test/fixtures/kin-computer-test-env.mjs'], {'unit', 'contracts'}),
            (['src/server.mjs', 'web/src/main.tsx'], {'unit', 'contracts', 'web'}),
            (['worker/internal/proxy/dialer_test.go'], {'worker'}),
            (['worker/main.go'], {'worker', 'unit', 'contracts'}),
            (['docs/tool.py'], set(ci.JOBS)),
            (['deploy/payload.json'], set(ci.JOBS)),
            (['.github/workflows/test.yml'], set(ci.JOBS)),
            (['new-area/input'], set(ci.JOBS)),
        ]:
            with self.subTest(paths=paths):
                self.assertEqual(ci.classify(paths), jobs)

    def test_manual_preview_and_missing_baseline_are_full(self):
        for name, event, preview in [('workflow_dispatch', {}, False), ('push', {}, False),
                                      ('push', {}, True)]:
            self.assertEqual(ci.plan(name, event, 'a' * 40, preview)[0], set(ci.JOBS))

    def test_rewritten_history_compares_delivery_trees_and_deleted_paths(self):
        old_cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as temp:
            try:
                os.chdir(temp)
                def git(*args):
                    return subprocess.check_output(['git', *args], stderr=subprocess.DEVNULL).decode().strip()
                git('init', '-q')
                git('config', 'user.email', 'test@example.invalid')
                git('config', 'user.name', 'Fixture')
                Path('src').mkdir()
                Path('src/a.mjs').write_text('upstream')
                git('add', 'src/a.mjs')
                git('commit', '-qm', 'upstream')
                source = git('rev-parse', 'HEAD')
                Path('src/a.mjs').write_text('customization')
                git('commit', '-qam', 'old delivery')
                before = git('rev-parse', 'HEAD')
                Path('docs').mkdir()
                Path('docs/change.md').write_text('notes')
                git('add', 'docs/change.md')
                tree = git('write-tree')
                after = git('commit-tree', tree, '-p', source, '-m', 'new single customization')
                git('checkout', '--detach', after)
                event = {'before': before, 'after': after, 'forced': True}
                self.assertEqual(ci.plan('push', event, after)[0], set())
                self.assertEqual(ci.plan('pull_request', {'pull_request': {'base': {'sha': before}}}, after)[0], set())
                self.assertEqual(ci.plan('push', {**event, 'before': 'a' * 40}, after)[0], set(ci.JOBS))
                self.assertEqual(ci.plan('push', {**event, 'after': source}, after)[0], set(ci.JOBS))
                git('rm', 'src/a.mjs')
                git('commit', '-qm', 'delete implementation')
                deleted = git('rev-parse', 'HEAD')
                self.assertEqual(ci.plan('push', {'before': after, 'after': deleted}, deleted)[0],
                                 {'unit', 'contracts'})
            finally:
                os.chdir(old_cwd)


class PrBaseTests(unittest.TestCase):
    def test_freezes_latest_base_and_reuses_it_after_remote_advances(self):
        old_cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as temp:
            try:
                def git(*args):
                    return subprocess.check_output(['git', *args], stderr=subprocess.DEVNULL).decode().strip()
                remote = Path(temp) / 'remote'
                remote.mkdir()
                os.chdir(remote)
                git('init', '-q', '-b', 'main')
                git('config', 'user.email', 'fixture@example.invalid')
                git('config', 'user.name', 'Fixture')
                Path('README.md').write_text('base')
                git('add', 'README.md')
                git('commit', '-qm', 'old base')
                old_base = git('rev-parse', 'HEAD')
                git('checkout', '-qb', 'feature')
                Path('docs').mkdir()
                Path('docs/change.md').write_text('PR notes')
                git('add', 'docs/change.md')
                git('commit', '-qm', 'PR')
                pr_head = git('rev-parse', 'HEAD')
                git('checkout', '-q', 'main')
                Path('src').mkdir()
                Path('src/new.mjs').write_text('base fix')
                git('add', 'src/new.mjs')
                git('commit', '-qm', 'latest base')
                latest = git('rev-parse', 'HEAD')
                checkout = Path(temp) / 'checkout'
                git('clone', '-q', str(remote), str(checkout))
                os.chdir(checkout)
                git('checkout', '-q', '--detach', pr_head)
                frozen = ci.merge_pr_base('main')
                self.assertEqual(frozen, latest)
                tree = git('rev-parse', 'HEAD^{tree}')
                paths = []
                selected, _ = ci.plan('pull_request', {'pull_request': {'base': {'sha': old_base}}},
                                      git('rev-parse', 'HEAD'), paths_out=paths, pr_base=frozen)
                self.assertEqual(selected, set())
                self.assertEqual(paths, ['docs/change.md'])
                os.chdir(remote)
                Path('src/new.mjs').write_text('later fix')
                git('commit', '-qam', 'remote advanced during jobs')
                os.chdir(checkout)
                git('checkout', '-q', '--detach', pr_head)
                self.assertEqual(ci.merge_pr_base('', frozen), latest)
                self.assertEqual(git('rev-parse', 'HEAD^{tree}'), tree)
                git('checkout', '-q', '--detach', pr_head)
                Path('README.md').write_text('PR edit')
                git('-c', 'user.name=ci', '-c', 'user.email=ci@localhost', 'commit', '-qam', 'conflicting PR')
                os.chdir(remote)
                Path('README.md').write_text('base edit')
                git('commit', '-qam', 'conflicting base')
                os.chdir(checkout)
                with self.assertRaises(subprocess.CalledProcessError):
                    ci.merge_pr_base('main')
            finally:
                os.chdir(old_cwd)

    def test_rejects_invalid_base_inputs_before_fetch(self):
        from unittest.mock import patch
        for sha in ['--upload-pack=evil', 'a' * 39, '0' * 40]:
            with patch.object(ci.subprocess, 'run') as run, self.assertRaises(ValueError):
                ci.merge_pr_base('main', sha)
            run.assert_not_called()


class DetailedSelectionTests(unittest.TestCase):
    def test_full_events_never_reuse_a_small_scope(self):
        d = ci.details(None, set(ci.JOBS))
        self.assertTrue(d['full_unit'])
        self.assertTrue(d['tooling'])
        self.assertEqual(d['go_modules'], ['worker', 'api-kernel'])
        self.assertIsNone(d['go_changes'])

    def test_source_boundary_test_only_and_new_caller_fallback(self):
        from unittest.mock import patch
        paths = [ci.IMAGE_PARSER]
        d = ci.details(paths, ci.classify(paths))
        self.assertEqual(d['unit_files'], sorted(ci.IMAGE_TESTS))
        self.assertFalse(d['unit_payload'])
        self.assertFalse(d['tooling'])
        test_path = 'test/unit/pricing.test.mjs'
        self.assertEqual(ci.details([test_path], {'unit'})['unit_files'], [test_path])
        with patch.object(ci.Path, 'rglob', return_value=[]):
            self.assertTrue(ci.details(paths, ci.classify(paths))['full_unit'])
        self.assertTrue(ci.details(['test/unit/deleted.test.mjs'], {'unit'})['full_unit'])
        self.assertTrue(ci.details(['src/server.mjs'], {'unit', 'contracts'})['full_unit'])
        self.assertFalse(ci.details(['src/server.mjs'], {'unit', 'contracts'})['tooling'])
        mixed = [ci.IMAGE_PARSER, 'worker/internal/proxy/dialer.go']
        self.assertTrue(ci.details(mixed, ci.classify(mixed))['full_unit'])

    def test_module_selection_and_unknown_fallback(self):
        for module in ['worker', 'api-kernel']:
            paths = [module + '/go.mod']
            self.assertEqual(ci.details(paths, ci.classify(paths))['go_modules'], [module])
        for path in ['.github/workflows/test.yml', 'docs/helper.py', 'package-lock.json', 'new/tool']:
            d = ci.details([path], ci.classify([path]))
            self.assertTrue(d['tooling'])
            self.assertEqual(d['go_modules'], ['worker', 'api-kernel'])

    def test_go_transitive_production_and_external_test_importers(self):
        root = Path.cwd() / 'worker'
        def package(name, **kwargs):
            return dict(ImportPath='example/' + name, Dir=str(root / name), **kwargs)
        packages = [package('lib'), package('service', Deps=['example/lib']),
                    package('cmd', Imports=['example/service']),
                    package('fixture', Imports=['example/lib']),
                    package('consumer', XTestImports=['example/fixture']), package('unrelated')]
        self.assertEqual(ci.go_targets('worker', ['worker/lib/change.go'], packages),
                         ['example/cmd', 'example/consumer', 'example/fixture', 'example/lib', 'example/service'])
        self.assertEqual(ci.go_targets('worker', ['worker/lib/lib_test.go'], packages), ['example/lib'])
        for changes in [None, ['worker/go.mod'], ['worker/deleted/a.go'], ['worker/lib/data.json']]:
            self.assertEqual(ci.go_targets('worker', changes, packages), ['./...'])
        stream = '\n'.join(__import__('json').dumps(p) for p in packages)
        self.assertEqual(list(ci.json_objects(stream)), packages)

    def test_unit_executor_isolates_files_and_rejects_shell_paths(self):
        from unittest.mock import patch
        import json
        with patch.dict(os.environ, {'UNIT_FILES': json.dumps(ci.IMAGE_TESTS)}), patch.object(ci.subprocess, 'run') as run:
            ci.run_unit()
            self.assertEqual([c.args[0] for c in run.call_args_list],
                             [['node', '--test', f] for f in ci.IMAGE_TESTS])
        with patch.dict(os.environ, {'UNIT_FILES': '["test/unit/../../evil.test.mjs"]'}), patch.object(ci.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                ci.run_unit()
            run.assert_not_called()

    def test_go_executor_runs_only_selected_module_and_keeps_distinct_build(self):
        from unittest.mock import patch
        import json
        root = Path.cwd() / 'worker'
        packages = [dict(ImportPath='example/lib', Dir=str(root / 'lib')),
                    dict(ImportPath='example/cmd', Dir=str(root / 'cmd'), Name='main', Deps=['example/lib'])]
        result = subprocess.CompletedProcess([], 0, '\n'.join(json.dumps(p) for p in packages))
        with patch.dict(os.environ, {'GO_MODULES': '["worker"]', 'GO_CHANGES': '["worker/lib/a.go"]'}), \
             patch.object(ci.subprocess, 'run', return_value=result) as run, \
             patch.object(ci.subprocess, 'check_output', return_value=''):
            ci.run_go()
            commands = [c.args[0] for c in run.call_args_list]
            self.assertEqual(commands[1], ['go', 'test', '-race', 'example/cmd', 'example/lib'])
            self.assertEqual(commands[2], ['go', 'build', '-trimpath', 'example/cmd'])
            self.assertTrue(all(c.kwargs['cwd'] == 'worker' for c in run.call_args_list))
            self.assertEqual(run.call_args_list[2].kwargs['env']['CGO_ENABLED'], '0')


if __name__ == '__main__':
    unittest.main()
