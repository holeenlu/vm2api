#!/usr/bin/env python3
"""Keep history consolidation from publishing guest images as a side effect."""
import json
import os
from pathlib import Path
import re
import subprocess


def git(repo, *args):
    return subprocess.run(['git', *args], cwd=repo, text=True, capture_output=True, check=False)


def decision(repo, event_name, event, expected_head):
    if event_name == 'workflow_dispatch':
        return True, 'Explicit manual guest-image publication.'
    if event_name != 'push':
        return False, 'This event does not publish guest images.'
    if event.get('forced'):
        return False, 'History was rewritten; guest images require a separate manual run.'
    before, after = event.get('before', ''), event.get('after', '')
    if any(not re.fullmatch(r'[0-9a-f]{40}', value) or value == '0' * 40 for value in (before, after)):
        return False, 'No verifiable before/after commits; automatic publication is disabled.'
    if after != expected_head or git(repo, 'rev-parse', 'HEAD').stdout.strip() != after:
        raise ValueError('checkout does not match the push target')
    if git(repo, 'merge-base', '--is-ancestor', before, after).returncode != 0:
        return False, 'Push is not a verifiable fast-forward; use a separate manual run.'
    changed = git(repo, 'diff', '--name-only', '-z', before, after)
    if changed.returncode:
        raise ValueError('cannot compare the before/after trees')
    relevant = any(path.startswith(('docker/kin-os/', 'docker/kin-kvm/'))
                   or path == '.github/workflows/guest-images.yml'
                   for path in changed.stdout.split('\0'))
    return relevant, ('Fast-forward changes affect guest-image inputs.' if relevant
                      else 'Guest-image inputs are unchanged between the actual before/after trees.')


def main():
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    publish, reason = decision(Path.cwd(), os.environ['GITHUB_EVENT_NAME'], event, os.environ['GITHUB_SHA'])
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(f'publish={str(publish).lower()}\n')
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(f'## Guest image publication\n\n{reason}\n')
    print(reason)


if __name__ == '__main__':
    main()
