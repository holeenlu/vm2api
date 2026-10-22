"""Conservative CI selection from actual before/after trees, including rewrites."""
import json
import os
import re
import subprocess
from pathlib import Path

JOBS = ('unit', 'worker', 'kernel', 'web', 'contracts')


def classify(paths):
    selected = set()
    for path in paths:
        # Documentation only: executable helpers under docs are not exempt.
        if (path.startswith('docs/') and path.endswith('.md')) or path in {
            'README.md', 'CHANGELOG.md', 'AGENTS.md', 'LICENSE',
        }:
            continue
        if path.startswith('web/'):
            selected.add('web')
        elif path.startswith(('src/', 'test/unit/', 'test/e2e/', 'test/fixtures/')):
            selected.update(('unit', 'contracts', 'web'))
        elif path.startswith(('worker/', 'api-kernel/')):
            selected.update(('worker', 'unit', 'contracts'))
        else:
            # Includes workflows, dependencies, payloads, build/deploy tooling,
            # selector changes and new directories not yet explicitly classified.
            return set(JOBS)
    return selected


def git(*args):
    return subprocess.check_output(['git', *args], stderr=subprocess.DEVNULL)


def plan(event_name, event, head, preview=False):
    if preview or event_name not in {'push', 'pull_request'}:
        return set(JOBS), 'manual, reusable preview or unsupported event: full checks'
    before = event.get('before') if event_name == 'push' else event.get('pull_request', {}).get('base', {}).get('sha')
    after = event.get('after') if event_name == 'push' else head
    if not all(isinstance(s, str) and re.fullmatch('[0-9a-f]{40}', s) and s != '0' * 40 for s in (before, after)):
        return set(JOBS), 'missing comparison SHA: full checks'
    try:
        if git('rev-parse', 'HEAD').decode().strip() != after:
            return set(JOBS), 'checkout differs from event: full checks'
        try:
            git('cat-file', '-e', before + '^{commit}')
        except subprocess.CalledProcessError:
            # A rewritten old main is not necessarily in checkout's history.
            # Fetch only the validated event SHA; never guess a substitute base.
            subprocess.run(['git', 'fetch', '--no-tags', '--depth=1', 'origin', before],
                           check=True, timeout=45, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)
        # Explicit endpoints, never merge-base or HEAD^ (the parent is upstream
        # after customization history is rebuilt). Renames include both paths.
        paths = git('diff', '--no-renames', '--name-only', '-z', before, after).decode().split('\0')
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, UnicodeError):
        return set(JOBS), 'comparison objects unavailable: full checks'
    paths = [p for p in paths if p]
    return classify(paths), f'{len(paths)} changed paths; actual before/after trees'


def main():
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    selected, reason = plan(os.environ['GITHUB_EVENT_NAME'], event, os.environ['GITHUB_SHA'],
                            bool(os.environ.get('PREVIEW_ARTIFACT')))
    outputs = ''.join(f'{job}={str(job in selected).lower()}\n' for job in JOBS)
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(outputs)
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(f'CI selection: {reason}\n\nSelected: {", ".join(sorted(selected)) or "documentation only"}\n')
    print(reason)
    print(outputs)


if __name__ == '__main__':
    main()
