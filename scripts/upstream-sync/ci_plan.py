"""Conservative CI selection from actual before/after trees, including rewrites."""
import json
import os
import re
import subprocess
import sys
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
        elif path.startswith('test/unit/'):
            selected.add('unit')
        elif path.startswith(('src/', 'test/e2e/', 'test/fixtures/')):
            selected.update(('unit', 'contracts'))
        elif path.startswith(('worker/', 'api-kernel/')):
            selected.update(('worker',) if path.endswith('_test.go') else ('worker', 'unit', 'contracts'))
        else:
            # Includes workflows, dependencies, payloads, build/deploy tooling,
            # selector changes and new directories not yet explicitly classified.
            return set(JOBS)
    return selected


def git(*args):
    return subprocess.check_output(['git', *args], stderr=subprocess.DEVNULL)


def plan(event_name, event, head, preview=False, paths_out=None):
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
    if paths_out is not None:
        paths_out.extend(paths)
    return classify(paths), f'{len(paths)} changed paths; actual before/after trees'


# Reviewed boundary: this pure parser is used only by the Images entry point.
IMAGE_PARSER = 'src/lib/protocol/image-edit-multipart.mjs'
IMAGE_TESTS = ['test/unit/image-edit-multipart.test.mjs', 'test/unit/handle-codex-images.test.mjs']


def details(paths, selected):
    full = paths is None
    paths = paths or []
    backend = [p for p in paths if p.startswith(('src/', 'test/unit/', 'test/e2e/', 'test/fixtures/'))]
    unit_files = set()
    bounded = bool(backend) and not full
    for path in backend:
        if path == IMAGE_PARSER:
            # A new caller invalidates the reviewed boundary.
            callers = {str(p) for p in Path('src').rglob('*.mjs')
                       if p.as_posix() != IMAGE_PARSER and 'image-edit-multipart' in p.read_text()}
            if callers != {'src/lib/protocol/handle-protocol.mjs'}:
                bounded = False
            unit_files.update(IMAGE_TESTS)
        elif path.startswith('test/unit/') and path.endswith('.test.mjs') and Path(path).is_file():
            unit_files.add(path)
        else:
            bounded = False
    if not all(Path(p).is_file() for p in unit_files):
        bounded = False
    tooling = full or any(not p.startswith(('src/', 'test/unit/', 'test/e2e/', 'test/fixtures/',
                                           'web/', 'worker/', 'api-kernel/', 'docs/'))
                          and p not in {'AGENTS.md', 'README.md', 'CHANGELOG.md', 'LICENSE'} for p in paths)
    # Unknown paths can classify as full, including executable files under docs.
    if selected == set(JOBS) and not all(p.startswith(('src/', 'test/unit/', 'test/e2e/', 'test/fixtures/',
                                                     'web/', 'worker/', 'api-kernel/')) or p.endswith('.md') for p in paths):
        tooling = True
    if tooling or any(p.startswith(('worker/', 'api-kernel/')) for p in paths):
        bounded = False
    modules = [m for m in ('worker', 'api-kernel') if any(p.startswith(m + '/') for p in paths)]
    if 'worker' in selected and (full or tooling or not modules):
        modules = ['worker', 'api-kernel']
    return dict(unit_files=sorted(unit_files) if bounded else [], full_unit=not bounded,
                tooling=tooling, unit_payload=not (bounded and unit_files <= set(IMAGE_TESTS)),
                go_modules=modules, go_changes=None if full or tooling else paths)


def json_objects(text):
    decoder = json.JSONDecoder()
    while text.strip():
        obj, end = decoder.raw_decode(text.lstrip())
        yield obj
        text = text.lstrip()[end:]


def go_targets(module, changes, packages):
    """Select changed packages plus transitive production and test importers."""
    changed = [p for p in changes or [] if p.startswith(module + '/')]
    if changes is None or not changed or any(not p.endswith('.go') for p in changed):
        return ['./...']
    by_name = {p['ImportPath']: p for p in packages}
    by_dir = {Path(p['Dir']).resolve(): p['ImportPath'] for p in packages}
    seeds = {by_dir.get(Path(p).parent.resolve()) for p in changed}
    if None in seeds:  # Deleted/tagged-out package cannot be mapped reliably.
        return ['./...']
    if all(p.endswith('_test.go') for p in changed):
        return sorted(seeds)
    selected = set(seeds)
    while True:
        more = {name for name, p in by_name.items()
                if set(p.get('Deps', []) + p.get('Imports', []) + p.get('TestImports', []) + p.get('XTestImports', [])) & selected}
        if more <= selected:
            return sorted(selected)
        selected |= more


def run_go():
    modules = json.loads(os.environ['GO_MODULES'])
    changes = json.loads(os.environ['GO_CHANGES'])
    for module in modules:
        if module not in ('worker', 'api-kernel'):
            raise ValueError('unknown Go module')
        try:
            result = subprocess.run(['go', 'list', '-json', './...'], cwd=module, check=True,
                                    capture_output=True, text=True)
            packages = list(json_objects(result.stdout))
            targets = go_targets(module, changes, packages)
        except (subprocess.CalledProcessError, ValueError, KeyError):
            packages = []
            targets = ['./...']
        print(f'{module}: {targets}', flush=True)
        formatted = subprocess.check_output(['gofmt', '-l', module], text=True)
        if formatted.strip():
            raise RuntimeError('gofmt needed: ' + formatted)
        # go test includes ordinary compilation and default vet. Race remains for
        # selected packages; production CGO-disabled commands are a distinct build.
        subprocess.run(['go', 'test', '-race', *targets], cwd=module, check=True)
        commands = ['./cmd/...'] if targets == ['./...'] else [
            p['ImportPath'] for p in packages if p['ImportPath'] in targets
            and p.get('Name') == 'main'
        ]
        test_only = changes is not None and all(p.endswith('_test.go') for p in changes if p.startswith(module + '/'))
        if commands and not test_only:
            subprocess.run(['go', 'build', '-trimpath', *commands], cwd=module, check=True,
                           env={**os.environ, 'CGO_ENABLED': '0'})


def run_unit():
    files = json.loads(os.environ.get('UNIT_FILES', '[]'))
    if not files:
        subprocess.run(['npm', 'run', 'test:unit'], check=True)
        return
    for file in files:
        if not re.fullmatch(r'test/unit/[a-zA-Z0-9_.-]+\.test\.mjs', file) or not Path(file).is_file():
            raise ValueError('invalid selected test: ' + file)
    # Same per-file process isolation as run-isolated-tests.mjs; no shell expansion.
    for file in files:
        subprocess.run(['node', '--test', file], check=True)


def main():
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    paths = []
    selected, reason = plan(os.environ['GITHUB_EVENT_NAME'], event, os.environ['GITHUB_SHA'],
                            bool(os.environ.get('PREVIEW_ARTIFACT')), paths)
    detail = details(paths if reason.endswith('actual before/after trees') else None, selected)
    outputs = ''.join(f'{job}={str(job in selected).lower()}\n' for job in JOBS)
    outputs += ''.join(f'{key}={json.dumps(value, separators=(",", ":"))}\n' for key, value in detail.items())
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(outputs)
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(f'CI selection: {reason}\n\nSelected: {", ".join(sorted(selected)) or "documentation only"}\n')
        summary.write('\nDetails: ' + json.dumps(detail) + '\n')
    print(reason)
    print(outputs)


if __name__ == '__main__':
    if sys.argv[1:] == ['run-unit']:
        run_unit()
    elif sys.argv[1:] == ['run-go']:
        run_go()
    elif sys.argv[1:]:
        raise SystemExit('unknown command')
    else:
        main()
