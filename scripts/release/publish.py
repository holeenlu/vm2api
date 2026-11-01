"""Publish only after the linux/amd64 assets and image exist."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

REPO = 'holeenlu/vm2api'
IMAGE = 'ghcr.io/holeenlu/tapmodels-gateway'
REQUIRED = ['kin-kernel', 'kin-kernel-crag', 'kin-codex-kernel', 'kin-worker', 'kin-egress', 'kin-slot-gate', 'kin-oauth-auth', 'kin-computer', 'cli-node', 'cc-node', 'ld-linux-x86-64.so.2', 'libc.so.6', 'libgcc_s.so.1', 'libm.so.6']
MAX_RELEASE_BODY = 120_000
RECENT_RELEASE_ENTRIES = 10
RELEASE_BODY_TRUNCATION = (
    '\n\n> The release notes excerpt is truncated to fit GitHub\'s 125,000-character limit. '
    'The complete customization notes remain available in the linked repository file.\n'
)


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def limit_release_body(body):
    if len(body) <= MAX_RELEASE_BODY:
        return body
    keep = MAX_RELEASE_BODY - len(RELEASE_BODY_TRUNCATION)
    return body[:keep].rstrip() + RELEASE_BODY_TRUNCATION


def recent_release_notes(notes, limit=RECENT_RELEASE_ENTRIES):
    headings = list(re.finditer(r'^##\s+.+$', notes, re.MULTILINE))
    if len(headings) <= limit:
        return notes
    return '\n\n'.join(
        notes[match.start():headings[index + 1].start() if index + 1 < len(headings) else len(notes)].strip()
        for index, match in enumerate(headings[:limit])
    )


def main():
    if os.environ.get('GITHUB_REPOSITORY') != REPO:
        raise SystemExit('Wrong publishing repository')
    plan = json.loads(Path('release-plan.json').read_text())
    if (plan.get('publish') != 'true' or plan.get('image') != IMAGE
            or not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+(?:\.(?:0|[1-9][0-9]*))?', plan.get('tag', ''))
            or plan.get('tag') != 'v' + plan.get('version', '')
            or '.'.join(plan.get('version', '').split('.')[:3]) != plan.get('upstream_version')
            or not Path('VERSION').is_file()
            or Path('VERSION').read_text().strip() != plan.get('version')
            or run('git', 'rev-parse', 'HEAD') != plan.get('commit')):
        raise SystemExit('Invalid release plan or checkout')
    notes_file = Path('docs/CUSTOMIZATION_RELEASE_NOTES.md')
    if not notes_file.is_file() or not notes_file.read_text().strip():
        raise SystemExit('Missing customization release notes')
    customization_notes = notes_file.read_text().strip()
    recent_notes = recent_release_notes(customization_notes)
    assets = Path('release-assets')
    for name in REQUIRED:
        if not (assets / name).is_file() or (assets / name).stat().st_size == 0:
            raise SystemExit(f'Missing asset: {name}')
    checksums = ''.join(f'{hashlib.sha256((assets/name).read_bytes()).hexdigest()}  {name}\n' for name in REQUIRED)
    (assets / 'checksums.txt').write_text(checksums)
    tag, image = plan['tag'], plan['image']
    image_info = json.loads(run('docker', 'buildx', 'imagetools', 'inspect', f'{image}:{tag}-amd64', '--format', '{{json .Image}}'))
    if image_info.get('architecture') != 'amd64' or image_info.get('os') != 'linux':
        raise SystemExit('Release image must be linux/amd64')
    run('docker', 'buildx', 'imagetools', 'create', '--tag', f'{image}:{tag}', f'{image}:{tag}-amd64')
    digest = json.loads(run('docker', 'buildx', 'imagetools', 'inspect', f'{image}:{tag}', '--format', '{{json .Manifest}}'))['digest']
    (assets / 'release-manifest.json').write_text(json.dumps({**plan, 'image_digest': digest, 'architectures': ['amd64']}, indent=2) + '\n')
    notes = f'''## tapmodels {tag}

Source commit: `{plan['source_commit']}` · release commit: `{plan['commit']}`

Upstream version prefix: v{plan['upstream_version']}.

Control plane: `{image}:{tag}` (`linux/amd64`).
All helper and payload assets are linux/amd64.
The guest kernels/CLIs retain the pinned upstream payload checksums from `deploy/payload.json`.

Install / update: https://github.com/{REPO}/blob/main/docs/BRANDING_AND_RELEASE.md
Full customization changes: https://github.com/{REPO}/blob/{plan['commit']}/docs/CUSTOMIZATION_RELEASE_NOTES.md

{recent_notes}
'''
    Path('release-notes.md').write_text(limit_release_body(notes))
    run('gh', 'release', 'upload', tag, *[str(p) for p in assets.iterdir()], '--repo', REPO, '--clobber')
    run('gh', 'release', 'edit', tag, '--repo', REPO, '--notes-file', 'release-notes.md', '--draft=false', '--latest')
    run('docker', 'buildx', 'imagetools', 'create', '--tag', f'{image}:latest', f'{image}@{digest}')


if __name__ == '__main__':
    main()
