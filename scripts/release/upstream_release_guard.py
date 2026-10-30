"""Release the complete system only when a push integrates a newer upstream version."""
import json
import os
from pathlib import Path
import re
import subprocess


def git(repo, *args):
    return subprocess.check_output(['git', *args], cwd=repo, text=True).strip()


def version(value):
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', value):
        raise ValueError('Expected a three-part upstream VERSION')
    return tuple(map(int, value.split('.')))


def decision(repo, event_name, event, expected_head):
    if event_name == 'workflow_dispatch':
        return True, 'Explicit manual release.'
    if event_name != 'push':
        return False, 'Only main pushes or manual runs can release.'
    before, after = event.get('before', ''), event.get('after', '')
    if any(not re.fullmatch(r'[0-9a-f]{40}', sha) or sha == '0' * 40 for sha in (before, after)):
        return False, 'No verifiable before/after commits; not releasing.'
    if after != expected_head or git(repo, 'rev-parse', 'HEAD') != after:
        raise ValueError('checkout does not match the push target')
    # The previous customized tip may no longer be reachable after an exact-lease push.
    # Missing history is an error, never a reason to treat this as a new version.
    old = git(repo, 'show', f'{before}:VERSION')
    new = git(repo, 'show', f'{after}:VERSION')
    if version(new) <= version(old):
        return False, 'Upstream version did not advance; local edits do not release.'
    parents = git(repo, 'show', '-s', '--format=%P', after).split()
    if len(parents) != 1:
        raise ValueError('Release source must have exactly one upstream parent')
    base = parents[0]
    if git(repo, 'show', f'{base}:VERSION') != new:
        raise ValueError('VERSION was not inherited from the upstream parent')
    old_parents = git(repo, 'show', '-s', '--format=%P', before).split()
    if len(old_parents) != 1:
        raise ValueError('Previous main must have exactly one upstream parent')
    subprocess.run(['git', 'merge-base', '--is-ancestor', old_parents[0], base], cwd=repo, check=True)
    return True, f'Integrated upstream version {new}; release application and all guest/KVM images.'


def main():
    if os.environ.get('GITHUB_REPOSITORY') != 'holeenlu/vm2api' or os.environ.get('GITHUB_REF') != 'refs/heads/main':
        raise ValueError('Releases are restricted to holeenlu/vm2api main')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    if os.environ['GITHUB_EVENT_NAME'] == 'push':
        before = event.get('before', '')
        if re.fullmatch(r'[0-9a-f]{40}', before) and before != '0' * 40:
            exists = subprocess.run(['git', 'cat-file', '-e', before + '^{commit}'], capture_output=True)
            if exists.returncode:
                subprocess.run(['git', 'fetch', '--no-tags', 'origin', before], check=True)
    release, reason = decision(Path.cwd(), os.environ['GITHUB_EVENT_NAME'], event, os.environ['GITHUB_SHA'])
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(f'release={str(release).lower()}\n')
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(f'## Complete system release\n\n{reason}\n')
    print(reason)


if __name__ == '__main__':
    main()
