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
            (['src/lib/admin/panel-acl.mjs'], {'unit', 'contracts', 'web'}),
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
                                 {'unit', 'contracts', 'web'})
            finally:
                os.chdir(old_cwd)


if __name__ == '__main__':
    unittest.main()
