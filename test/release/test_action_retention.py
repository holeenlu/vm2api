import importlib.util
import os
from pathlib import Path
import re
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('retention', ROOT / 'scripts/release/prune_action_runs.py')
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)


def runs(count):
    return [{'id': i, 'created_at': f'2026-10-{i:02d}T00:00:00Z',
             'status': 'completed', 'name': f'workflow-{i % 3}'} for i in range(1, count + 1)]


class ActionRetentionTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {'GH_REPO': retention.REPOSITORY})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_pagination_retains_ten_globally_in_creation_order_and_defaults_to_preview(self):
        calls = []
        def request(*args):
            calls.append(args)
            return [{'workflow_runs': runs(8)}, {'workflow_runs': runs(13)[8:]}]
        report = retention.prune(request=request)
        self.assertEqual(report['keep'], list(range(13, 3, -1)))
        self.assertEqual(report['delete'], [1, 2, 3])
        self.assertFalse(report['apply'])
        self.assertEqual(len(calls), 1)
        self.assertIn('--paginate', calls[0])

    def test_ten_or_fewer_runs_are_untouched(self):
        for size in (0, 4, 10):
            report = retention.prune(apply=True, request=lambda *args: [{'workflow_runs': runs(size)}])
            self.assertEqual(report['delete'], [])

    def test_active_or_restarted_runs_are_never_deleted(self):
        records = runs(13)
        records[0]['status'] = 'in_progress'
        calls = []
        def request(*args):
            calls.append(args)
            if '--slurp' in args:
                return [{'workflow_runs': records}]
            return {'status': 'queued' if args[0].endswith('/2') else 'completed'}
        report = retention.prune(apply=True, request=request)
        self.assertEqual(report['active'], [1, 2])
        self.assertEqual(report['delete'], [3])
        deletes = [call for call in calls if 'DELETE' in call]
        self.assertEqual(deletes, [('--method', 'DELETE', f'repos/{retention.REPOSITORY}/actions/runs/3')])

    def test_inventory_failure_never_continues_to_deletion(self):
        calls = []
        def request(*args):
            calls.append(args)
            raise subprocess.CalledProcessError(1, 'gh')
        with self.assertRaises(subprocess.CalledProcessError):
            retention.prune(apply=True, request=request)
        self.assertEqual(len(calls), 1)

    def test_other_repositories_are_rejected_before_any_api_call(self):
        with patch.dict(os.environ, {'GH_REPO': 'dofastted/vm2api'}):
            with self.assertRaises(ValueError):
                retention.prune(apply=True, request=lambda *args: self.fail('unexpected API call'))

    def test_completion_triggers_cover_other_workflows_without_triggering_itself(self):
        workflow = (ROOT / '.github/workflows/actions-retention.yml').read_text()
        trigger = re.search(r'workflows: \[(.*?)\]', workflow)[1].split(', ')
        names = [re.search(r'^name: (.+)$', p.read_text(), re.M)[1]
                 for p in (ROOT / '.github/workflows').glob('*.yml')
                 if p.name != 'actions-retention.yml']
        self.assertEqual(set(trigger), set(names))
        self.assertNotIn('Actions retention', trigger)
        self.assertIn('schedule:', workflow)
        self.assertIn('actions: write', workflow)
        self.assertIn('ref: main', workflow)


if __name__ == '__main__':
    unittest.main()
