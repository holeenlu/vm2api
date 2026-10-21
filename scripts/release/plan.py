"""Plan X.Y.Z.N fork releases from the latest stable author release."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

REPOSITORY = 'holeenlu/vm2api'
UPSTREAM = 'dofastted/vm2api'
IMAGE = 'ghcr.io/holeenlu/tapmodels-gateway'
NUMBER = r'(?:0|[1-9][0-9]*)'
UPSTREAM_VERSION = rf'{NUMBER}\.{NUMBER}\.{NUMBER}'
FORK_VERSION = rf'{UPSTREAM_VERSION}\.[1-9][0-9]*'


def version_tuple(value):
    if not re.fullmatch(FORK_VERSION, value):
        raise ValueError('Version must be X.Y.Z.N, with N starting at 1 (for example 1.3.204.1)')
    return tuple(map(int, value.split('.')))


def upstream_version(release):
    tag = release.get('tag_name', '')
    if release.get('draft') or release.get('prerelease') or not re.fullmatch(rf'v{UPSTREAM_VERSION}', tag):
        raise ValueError('Latest upstream release must be a published stable vX.Y.Z tag')
    return tag[1:]


def next_version(base, releases, requested='', tags=()):
    if not re.fullmatch(UPSTREAM_VERSION, base):
        raise ValueError('Upstream version must be X.Y.Z')
    prefix = tuple(map(int, base.split('.')))
    reserved = []
    for tag in [r.get('tag_name', '') for r in releases] + list(tags):
        if re.fullmatch(rf'v{FORK_VERSION}', tag):
            value = version_tuple(tag[1:])
            if value[:3] == prefix:
                reserved.append(value[3])
    revision = max(reserved, default=0) + 1
    if requested:
        current = version_tuple(requested.removeprefix('v'))
        if current[:3] != prefix:
            raise ValueError(f'Version prefix must match the latest upstream release v{base}')
        if current[3] < revision:
            raise ValueError(f'Version is already reserved; next available version is v{base}.{revision}')
        revision = current[3]
    return f'{base}.{revision}'


def stamp_version(version):
    version_tuple(version)
    Path('VERSION').write_text(version + '\n')


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def pages(endpoint):
    return [item for page in json.loads(run('gh', 'api', '--paginate', '--slurp', endpoint)) for item in page]


def main():
    if os.environ.get('GITHUB_REPOSITORY') != REPOSITORY or os.environ.get('GITHUB_REF') != 'refs/heads/main':
        raise SystemExit('Release must run from holeenlu/vm2api main')
    publish = os.environ.get('PUBLISH') == 'true'
    source = run('git', 'rev-parse', 'HEAD')
    upstream = json.loads(run('gh', 'api', f'repos/{UPSTREAM}/releases/latest'))
    base = upstream_version(upstream)
    releases = pages(f'repos/{REPOSITORY}/releases?per_page=100')
    tags = [t['name'] for t in pages(f'repos/{REPOSITORY}/tags?per_page=100')]
    version = next_version(base, releases, os.environ.get('RELEASE_VERSION', '').strip(), tags)
    tag = f'v{version}'
    commit = source
    if publish:
        stamp_version(version)
        run('git', 'config', 'user.name', 'github-actions[bot]')
        run('git', 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
        run('git', 'add', 'VERSION')
        run('git', 'commit', '--allow-empty', '-m', f'release: {tag}')
        commit = run('git', 'rev-parse', 'HEAD')
        run('git', 'tag', tag)
        run('git', 'push', f'https://github.com/{REPOSITORY}.git', f'refs/tags/{tag}:refs/tags/{tag}')
        run('gh', 'release', 'create', tag, '--repo', REPOSITORY, '--verify-tag', '--draft', '--title', f'tapmodels {tag}', '--notes', f'Build in progress. Source: {source}; upstream version prefix: v{base}')
    result = {'version': version, 'tag': tag, 'commit': commit, 'source_commit': source,
              'upstream_version': base, 'image': IMAGE, 'publish': str(publish).lower()}
    Path('release-plan.json').write_text(json.dumps(result, indent=2) + '\n')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        for key, value in result.items():
            output.write(f'{key}={value}\n')
    print(json.dumps(result))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stamp-version', help='Apply an already planned X.Y.Z.N version to an isolated build checkout')
    args = parser.parse_args()
    if args.stamp_version:
        stamp_version(args.stamp_version)
    else:
        main()
