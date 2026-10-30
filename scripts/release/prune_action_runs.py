"""Keep the latest ten repository-wide Actions runs; active runs are never deleted."""
import argparse
import json
import os
import subprocess

REPOSITORY = 'holeenlu/vm2api'
KEEP = 10


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
    report = {'keep': [run['id'] for run in ordered[:KEEP]], 'delete': [], 'active': [], 'apply': apply}
    for run in reversed(ordered[KEEP:]):
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
    parser.add_argument('--apply', action='store_true', help='delete completed runs beyond the latest ten')
    args = parser.parse_args()
    print(json.dumps(prune(apply=args.apply), indent=2))
