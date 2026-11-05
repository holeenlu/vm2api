"""Pure release/deployment contracts shared by planning and publication steps."""
import re

UPSTREAM_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
FORK_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+\.(?:0|[1-9][0-9]*)$")
RELEASE_TAG = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+(?:\.(?:0|[1-9][0-9]*))?$")
ASSET_NAME = re.compile(r"^[A-Za-z0-9._-]+$")
DEPLOY_TAG = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+(?:\.(?:0|[1-9][0-9]*))?$")


def release_tag_key(tag):
    match = DEPLOY_TAG.fullmatch(str(tag or '').strip())
    if not match:
        return None
    parts = tuple(int(part) for part in match.group(0)[1:].split('.'))
    return parts + (0,) * (4 - len(parts))


def require_upstream_version(value):
    value = str(value or '').strip()
    if not UPSTREAM_VERSION.fullmatch(value):
        raise ValueError('Upstream VERSION must be X.Y.Z')
    return value


def require_fork_version(value):
    value = str(value or '').strip()
    if not FORK_VERSION.fullmatch(value):
        raise ValueError('Fork VERSION must be X.Y.Z.N')
    return value


def require_release_tag(value):
    value = str(value or '').strip()
    if not RELEASE_TAG.fullmatch(value):
        raise ValueError('Release tag must be vX.Y.Z or vX.Y.Z.N')
    return value


def release_source_contract(*, source_commit, upstream_parent, version, parent_version):
    if not re.fullmatch(r'[0-9a-f]{40}', str(source_commit or '')):
        raise ValueError('Release source must be a commit SHA')
    if not re.fullmatch(r'[0-9a-f]{40}', str(upstream_parent or '')):
        raise ValueError('Release requires exactly one upstream parent')
    version = str(version or '').strip()
    parent_version = require_upstream_version(parent_version)
    if version != parent_version and not (version.startswith(parent_version + '.') and FORK_VERSION.fullmatch(version)):
        raise ValueError('Source VERSION must inherit the upstream version prefix')
    return {'source_commit': source_commit, 'upstream_parent': upstream_parent, 'version': version}


def require_asset_contract(asset_names, required_names):
    """Validate the release asset boundary without touching the filesystem."""
    names = {str(name) for name in asset_names}
    required = {str(name) for name in required_names}
    invalid = sorted(name for name in names if not ASSET_NAME.fullmatch(name))
    if invalid:
        raise ValueError(f'Invalid release asset name: {invalid[0]}')
    missing = sorted(required - names)
    if missing:
        raise ValueError(f'Missing asset: {missing[0]}')
    return tuple(sorted(names))


def image_platform_contract(*, architecture, operating_system, expected_architecture='amd64', expected_os='linux'):
    if architecture != expected_architecture or operating_system != expected_os:
        raise ValueError('Release image must be linux/amd64')
    return {'architecture': architecture, 'os': operating_system}


def normalize_deploy_tag(value):
    """Normalize vX.Y.Z[.N] tags while rejecting architecture suffixes."""
    raw = str(value or '').strip()
    for suffix in ('-amd64', '-x86_64', '-arm64', '-aarch64'):
        if raw.endswith(suffix):
            raw = raw[: -len(suffix)]
            break
    if not raw.startswith('v'):
        raw = 'v' + raw
    if not DEPLOY_TAG.fullmatch(raw):
        raise ValueError('Invalid deploy release tag')
    return raw


def deploy_architecture(machine):
    value = str(machine or '').strip().lower()
    if value in ('x86_64', 'amd64', 'x64'):
        return 'amd64'
    if value in ('aarch64', 'arm64'):
        return 'arm64'
    raise ValueError(f'Unsupported host architecture: {machine}')


def deploy_image_tag(tag, architecture):
    tag = normalize_deploy_tag(tag)
    architecture = deploy_architecture(architecture)
    return f'{tag}-arm64' if architecture == 'arm64' else tag
