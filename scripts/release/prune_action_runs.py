"""Keep the latest ten repository-wide Actions runs; active runs are never deleted.

This workflow's own runs are budgeted separately. It is triggered by every other
workflow's completion, so each push produced several bookkeeping runs that were
created *after* the ci / perf / worker-e2e runs they followed. Counting them
against the same ten evicted every verdict within minutes: on 2026-11-07 the
repository held eight `Actions retention` runs, two skipped `pr-rerun` runs and
no ci, perf or worker-e2e run at all. The ten now count the workflows that
produce verdicts; this one keeps its own latest two.
"""
import argparse
import json
import os
import subprocess

REPOSITORY = 'holeenlu/vm2api'
RETENTION_WORKFLOW = 'Actions retention'
KEEP = 10
KEEP_RETENTION = 2


def api(*args):
    result = subprocess.run(['gh', 'api', *args], check=True, text=True, capture_output=True)
    return json.loads(result.stdout) if result.stdout.strip() else None


def prune(*, apply=False, request=api):
    repository = os.environ.get('GH_REPO', REPOSITORY)
    if repository != REPOSITORY:
        raise ValueError(f'Actions cleanup is restricted to {REPOSITORY}')
    pages = request('--paginate', '--slurp', f'repos/{repository}/actions/runs?per_page=100')
    runs = {run['id']: run for page in pages for run in page['workflow_runs']}
    ordered = sorted(runs.values(), key=lambda run: (run['created_at'], run['id']), reverse=True)
    budget = {False: KEEP, True: KEEP_RETENTION}
    kept, expired = [], []
    for run in ordered:
        own = run.get('name') == RETENTION_WORKFLOW
        if budget[own] > 0:
            budget[own] -= 1
            kept.append(run)
        else:
            expired.append(run)
    report = {'keep': [run['id'] for run in kept], 'delete': [], 'active': [], 'apply': apply}
    for run in reversed(expired):
        run_id = run['id']
        if run['status'] != 'completed':
            report['active'].append(run_id)
            continue
        if apply:
            # A rerun may have started since the paginated inventory was collected.
            current = request(f'repos/{repository}/actions/runs/{run_id}')
            if current['status'] != 'completed':
                report['active'].append(run_id)
                continue
            request('--method', 'DELETE', f'repos/{repository}/actions/runs/{run_id}')
        report['delete'].append(run_id)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true',
                        help='delete completed runs beyond the latest ten (this workflow: latest two)')
    args = parser.parse_args()
    print(json.dumps(prune(apply=args.apply), indent=2))
