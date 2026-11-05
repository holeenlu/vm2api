"""Pure architecture and release-tag rules for the tapmodels installer."""
import re
import sys

TAG = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+(?:\.(?:0|[1-9][0-9]*))?$")


def normalize_tag(value):
    raw = str(value or '').strip()
    for suffix in ('-amd64', '-x86_64', '-arm64', '-aarch64'):
        if raw.endswith(suffix):
            raw = raw[: -len(suffix)]
            break
    if not raw.startswith('v'):
        raw = 'v' + raw
    if not TAG.fullmatch(raw):
        raise ValueError('invalid release tag')
    return raw


def architecture(value):
    raw = str(value or '').strip().lower()
    if raw in ('x86_64', 'amd64', 'x64'):
        return 'amd64'
    if raw in ('aarch64', 'arm64'):
        return 'arm64'
    raise ValueError(f'unsupported host architecture: {value}')


def image_tag(tag, host):
    normalized = normalize_tag(tag)
    return normalized + '-arm64' if architecture(host) == 'arm64' else normalized


def main(argv):
    if len(argv) < 3:
        raise SystemExit('usage: install_contracts.py <normalize-tag|arch|image-tag> value [host]')
    command, value = argv[1], argv[2]
    if command == 'normalize-tag':
        print(normalize_tag(value))
    elif command == 'arch':
        print(architecture(value))
    elif command == 'image-tag':
        if len(argv) != 4:
            raise SystemExit('image-tag requires host architecture')
        print(image_tag(value, argv[3]))
    else:
        raise SystemExit(f'unknown command: {command}')


if __name__ == '__main__':
    main(sys.argv)
