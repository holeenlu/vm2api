#!/usr/bin/env python3
"""Read-only upstream preview. Never pushes refs, dispatches releases, or runs candidate code."""
import argparse
import fnmatch
import hashlib
import html
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

REPOSITORY = 'holeenlu/vm2api'
UPSTREAM_URL = 'https://github.com/dofastted/vm2api.git'
CANDIDATE_REF = 'refs/heads/preview-candidate'
MIGRATIONS = 'src/lib/db/migrations/'
SIDE_EFFECT_PATHS = ['docker/kin-os/*', 'docker/kin-kvm/*', '.github/workflows/guest-images.yml']
SENSITIVE_PATHS = ['.github/*', 'scripts/release/*', 'scripts/upstream-sync/*', 'deploy/*', 'docker/*',
                   'AGENTS.md', 'docs/CHANGE_DELIVERY.md', 'package*.json',
                   'web/package.json', 'web/pnpm-lock.yaml', 'worker/go.*', 'api-kernel/go.*']


def command(*args, cwd=None, check=True, binary=False):
    result = subprocess.run(args, cwd=cwd, text=not binary, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=180)
    if check and result.returncode:
        raise RuntimeError(f'{args[0]} failed ({result.returncode}): {result.stderr.strip()}')
    return result


def git(repo, *args, check=True, binary=False):
    # A detached maintenance worker can race TemporaryDirectory cleanup.
    return command('git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
                   '-c', 'rerere.enabled=false', '-c', 'maintenance.auto=false',
                   '-c', 'gc.auto=0', *args, cwd=repo, check=check, binary=binary)


def sha(value):
    if not re.fullmatch(r'[0-9a-f]{40}', value or ''):
        raise ValueError('expected a full lowercase Git SHA')
    return value


def paths(repo, *args):
    return [p for p in git(repo, *args).stdout.split('\0') if p]


def load_contracts(repo):
    data = json.loads((Path(repo) / 'scripts/upstream-sync/contracts.json').read_text())
    if data.get('version') != 1 or not data.get('features'):
        raise ValueError('unsupported or empty contract manifest')
    ids = set()
    for feature in data['features']:
        if not re.fullmatch(r'[a-z][a-z0-9-]+', feature['id']) or feature['id'] in ids:
            raise ValueError('invalid or duplicate contract id')
        ids.add(feature['id'])
        for name in feature['requirements'] + feature['unit_tests'] + feature['e2e_tests']:
            if Path(name).is_absolute() or '..' in Path(name).parts or not (Path(repo) / name).is_file():
                raise ValueError(f'contract {feature["id"]} has missing or unsafe reference: {name}')
    return data


def match_paths(files, patterns):
    return sorted(p for p in files if any(fnmatch.fnmatchcase(p, pattern) for pattern in patterns))


def classify(files, contracts):
    return [{'id': feature['id'], 'paths': match_paths(files, feature['paths']),
             'requirements': feature['requirements'],
             'tests': feature['unit_tests'] + feature['e2e_tests']}
            for feature in contracts['features'] if match_paths(files, feature['paths'])]


def migration_checks(repo, base):
    historical = paths(repo, 'ls-tree', '-r', '--name-only', '-z', base, '--', MIGRATIONS)
    current = paths(repo, 'ls-files', '-z', '--', MIGRATIONS)
    errors = []
    versions = {}
    historical_set = set(historical)
    max_old = max((int(Path(p).name.split('_')[0]) for p in historical if p.endswith('.sql')), default=0)
    for p in current:
        if not p.endswith('.sql'):
            continue
        version = int(Path(p).name.split('_')[0])
        if version in versions:
            previous = versions[version]
            # The migration runner keeps files with an already-published duplicate
            # prefix distinct by filename.  Preserve such historical pairs while
            # still blocking a collision introduced by the candidate merge.
            if previous not in historical_set or p not in historical_set:
                errors.append(f'duplicate migration version {version}: {previous} / {p}')
        versions[version] = p
        if p not in historical and version <= max_old:
            errors.append(f'new migration must follow existing version {max_old}: {p}')
    for p in historical:
        old = git(repo, 'rev-parse', f'{base}:{p}').stdout.strip()
        new = git(repo, 'rev-parse', f':{p}', check=False)
        if new.returncode or new.stdout.strip() != old:
            errors.append(f'applied migration changed or removed: {p}')
    return errors


def contract_checks(repo, contracts):
    errors = []
    for feature in contracts['features']:
        for name in feature['requirements'] + feature['unit_tests'] + feature['e2e_tests']:
            entry = git(repo, 'ls-files', '--stage', '--', name).stdout.strip()
            if not entry or entry.split()[0] not in ('100644', '100755'):
                errors.append(f'protected contract reference removed or not a regular file: {name}')
    return errors


def previous_result(base, artifact_name):
    """Only a completed run of this workflow with a nonexpired result artifact can deduplicate."""
    if not (os.environ.get('GH_TOKEN') and os.environ.get('GITHUB_REPOSITORY') == REPOSITORY):
        return None
    artifacts = json.loads(command('gh', 'api',
        f'repos/{REPOSITORY}/actions/artifacts?name={artifact_name}&per_page=100').stdout)['artifacts']
    for artifact in artifacts:
        run = artifact.get('workflow_run') or {}
        run_id = run.get('id')
        if artifact.get('expired') or run.get('head_sha') != base or str(run_id) == os.environ.get('GITHUB_RUN_ID'):
            continue
        if not isinstance(run_id, int):
            continue
        info = json.loads(command('gh', 'api', f'repos/{REPOSITORY}/actions/runs/{run_id}').stdout)
        if (info.get('path') == '.github/workflows/upstream-sync.yml'
                and info.get('status') == 'completed' and info.get('conclusion') in ('success', 'failure')):
            return {'run_id': run_id, 'conclusion': info['conclusion'],
                    'url': f'https://github.com/{REPOSITORY}/actions/runs/{run_id}'}
    return None


def output_values(state):
    return {'status': state['status'], 'candidate_sha': state.get('candidate_sha', ''),
            'source_sha': state.get('source_sha', ''),
            'has_candidate': str(bool(state.get('candidate_sha'))).lower(),
            'record': str(state['status'] not in ('up_to_date', 'already_checked')).lower(),
            'result_artifact': state.get('result_artifact', 'upstream-preview-error'),
            'should_fail': str(state['status'] in ('error', 'conflicts', 'contracts_blocked', 'ci_failed')).lower()}


def write_report(output, state, *, emit=False):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    (output / 'state.json').write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')
    safe = lambda value: html.escape(str(value)).replace(chr(96), '&#96;')
    lines = ['# 上游同步预检', '', f'- 状态：{safe(state["status"])}',
             f'- 模式：{safe(state.get("mode", "upstream"))}',
             f'- 本地基点：{safe(state.get("base_sha", "unknown"))}',
             f'- 冻结上游：{safe(state.get("source_sha", "unavailable"))}',
             f'- 共同祖先：{safe(state.get("merge_base", "unknown"))}',
             f'- 候选提交：{safe(state.get("candidate_sha", "未生成"))}',
             f'- 候选树：{safe(state.get("candidate_tree", "未生成"))}',
             f'- CI：{safe(state.get("ci_result", "尚未执行"))}', '',
             '**仅预检；未更新 main、未创建 PR、未发布镜像或版本、未部署。**',
             '自动合并和测试通过不代表语义审查通过；业务取舍仍按 CHANGE_DELIVERY.md 执行。', '']
    if state.get('previous'):
        lines += ['本批输入以前已检查，本次未重复验证（不冒充当前测试结果）：',
                  safe(state['previous']['url']), f'先前结论：{safe(state["previous"]["conclusion"])}', '']
    for title, key in [('需审查的定制', 'features'), ('文本冲突', 'conflicts'),
                       ('静态契约阻断', 'blockers'), ('发布副作用路径', 'side_effect_paths'),
                       ('敏感路径', 'sensitive_paths'), ('提示', 'warnings')]:
        lines += ['## ' + title, '']
        for value in state.get(key, []):
            if isinstance(value, dict):
                lines += ['- ' + safe(value['id']), '  - 需求：' + safe(', '.join(value['requirements'])),
                          '  - 入口：' + safe(', '.join(value['paths'])), '  - 回归：' + safe(', '.join(value['tests']))]
            else:
                lines.append('- ' + safe(value))
        if not state.get(key):
            lines.append('- 无')
        lines.append('')
    lines += ['## 来源变更', '', *['- ' + safe(p) for p in state.get('source_paths', [])], '',
              '候选/输入 bundle 在本次 upstream-preview-inputs artifact；结果保留 14 天。',
              '手动 mode=baseline 只验当前 main；force=true 重新检查相同输入。', '']
    text = '\n'.join(lines)
    (output / 'report.md').write_text(text)
    if emit and os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
            for key, value in output_values(state).items():
                stream.write(f'{key}={value}\n')
    if emit and os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
            stream.write(text if len(text) <= 60000 else text[:60000] + "\n\nSummary 已截短，完整内容见 report artifact。\n")


def prepare(repo, output, *, mode='upstream', force=False, source_url=UPSTREAM_URL, lookup=previous_result):
    repo, output = Path(repo).resolve(), Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    contracts = load_contracts(repo)
    base = sha(git(repo, 'rev-parse', 'HEAD').stdout.strip())
    state = {'status': 'preparing', 'mode': mode, 'base_sha': base, 'repository': REPOSITORY,
             'upstream': 'dofastted/vm2api/main', 'warnings': [], 'features': []}
    with tempfile.TemporaryDirectory(prefix='tapmodels-upstream-preview-') as temporary:
        candidate = Path(temporary) / 'candidate'
        git(repo, 'clone', '--no-hardlinks', '--no-checkout', str(repo), str(candidate))
        git(candidate, 'config', 'user.name', 'tapmodels upstream preview')
        git(candidate, 'config', 'user.email', 'preview@tapmodels.invalid')
        git(candidate, 'checkout', '--detach', base)
        git(candidate, 'fetch', '--no-tags', source_url, 'refs/heads/main')
        source = sha(git(candidate, 'rev-parse', 'FETCH_HEAD').stdout.strip())
        merge_base = git(candidate, 'merge-base', base, source).stdout.strip()
        state.update(source_sha=source, merge_base=merge_base,
                     result_artifact=f'upstream-preview-{mode}-{base}-{source}')
        state['source_paths'] = paths(candidate, 'diff', '--name-only', '-z', merge_base, source)
        state['features'] = classify(state['source_paths'], contracts)
        state['side_effect_paths'] = match_paths(state['source_paths'], SIDE_EFFECT_PATHS)
        state['sensitive_paths'] = match_paths(state['source_paths'], SENSITIVE_PATHS)
        (output / 'source-commits.txt').write_text(git(candidate, 'log', '--format=%H %s', f'{base}..{source}').stdout)
        if mode != 'baseline':
            changelog = git(candidate, 'ls-tree', source, '--', 'CHANGELOG.md').stdout.split()
            if len(changelog) != 4 or changelog[0] not in ('100644', '100755') or changelog[1] != 'blob':
                raise ValueError('frozen upstream CHANGELOG.md must be a regular tracked file')
            state['changelog_blob'] = changelog[2]
            if (git(candidate, 'merge-base', '--is-ancestor', source, base, check=False).returncode == 0
                    and git(candidate, 'diff', '--quiet', source, base, '--', 'CHANGELOG.md', check=False).returncode == 0):
                state['status'] = 'up_to_date'
                return state
        if mode != 'baseline' and not force:
            try:
                state['previous'] = lookup(base, state['result_artifact'])
            except (RuntimeError, ValueError, KeyError) as error:
                state['warnings'].append('历史结果查询失败，本次完整重验：' + str(error))
            if state.get('previous'):
                state['status'] = 'already_checked'
                return state
        git(candidate, 'update-ref', 'refs/heads/preview-base', base)
        git(candidate, 'update-ref', 'refs/heads/preview-source', source)
        if mode != 'baseline':
            result = git(candidate, 'merge', '--no-ff', '--no-commit', source, check=False)
            (output / 'merge.log').write_text(result.stdout + result.stderr)
            conflicts = paths(candidate, 'diff', '--name-only', '--diff-filter=U', '-z')
            if result.returncode and not conflicts:
                raise RuntimeError('merge failed without resolvable conflict entries: ' + result.stderr)
            # This one file is upstream-owned; customization notes live separately.
            git(candidate, 'restore', f'--source={source}', '--staged', '--worktree', '--', 'CHANGELOG.md')
            state['conflicts'] = paths(candidate, 'diff', '--name-only', '--diff-filter=U', '-z')
            if state['conflicts']:
                state['status'] = 'conflicts'
                (output / 'conflicts.patch').write_bytes(git(candidate, 'diff', '--cc', binary=True).stdout)
                git(candidate, 'bundle', 'create', str(output / 'inputs.bundle'),
                    'refs/heads/preview-base', 'refs/heads/preview-source')
                return state
        state['blockers'] = migration_checks(candidate, base) + contract_checks(candidate, contracts)
        (output / 'candidate.patch').write_text(git(candidate, 'diff', '--cached', '--binary', base).stdout)
        if state['blockers']:
            state['status'] = 'contracts_blocked'
            git(candidate, 'bundle', 'create', str(output / 'inputs.bundle'),
                'refs/heads/preview-base', 'refs/heads/preview-source')
            return state
        tree = sha(git(candidate, 'write-tree').stdout.strip())
        candidate_sha = base
        if mode != 'baseline':
            # The temporary merge resolves the tree only. Published/preview history
            # contains one customization commit whose sole parent is frozen upstream.
            candidate_sha = sha(git(candidate, 'commit-tree', tree, '-p', source, '-m',
                f'Preview tapmodels customization on {source}\n\nPreview-Base: {base}\n'
                'Not for automatic publication; review and refresh cumulative release notes.').stdout.strip())
        state.update(status='candidate_ready', candidate_sha=candidate_sha, candidate_tree=tree)
        git(candidate, 'update-ref', CANDIDATE_REF, state['candidate_sha'])
        git(candidate, 'bundle', 'create', str(output / 'candidate.bundle'), CANDIDATE_REF)
        git(candidate, 'bundle', 'verify', str(output / 'candidate.bundle'))
        state['bundle_sha256'] = hashlib.sha256((output / 'candidate.bundle').read_bytes()).hexdigest()
        return state


def restore(repo, bundle, expected, *, source):
    expected = sha(expected)
    source = sha(source)
    repo, bundle = Path(repo).resolve(), Path(bundle).resolve()
    baseline = sha(git(repo, 'rev-parse', 'HEAD').stdout.strip())
    if git(repo, 'status', '--porcelain', '--untracked-files=all').stdout.strip():
        raise ValueError('candidate restore requires a clean runner checkout')
    heads = git(repo, 'bundle', 'list-heads', str(bundle)).stdout.splitlines()
    if heads != [f'{expected} {CANDIDATE_REF}']:
        raise ValueError('bundle candidate ref/SHA does not match trusted preparation outputs')
    git(repo, 'bundle', 'verify', str(bundle))
    git(repo, 'fetch', '--no-tags', str(bundle), CANDIDATE_REF)
    if git(repo, 'rev-parse', 'FETCH_HEAD').stdout.strip() != expected:
        raise ValueError('fetched candidate differs from reviewed SHA')
    parents = git(repo, 'show', '-s', '--format=%P', expected).stdout.strip().split()
    if expected != baseline:
        message = git(repo, 'show', '-s', '--format=%B', expected).stdout.splitlines()
        if parents != [source] or message.count(f'Preview-Base: {baseline}') != 1:
            raise ValueError('candidate is not the single customization prepared from this workflow baseline/source')
        if git(repo, 'diff', '--quiet', source, expected, '--', 'CHANGELOG.md', check=False).returncode:
            raise ValueError('candidate CHANGELOG.md differs from frozen upstream')
    git(repo, 'checkout', '--detach', expected)


def finish(output, ci_result):
    output = Path(output)
    state = json.loads((output / 'state.json').read_text())
    state['ci_result'] = ci_result
    if state['status'] == 'candidate_ready':
        state['status'] = 'validated' if ci_result == 'success' else 'ci_failed'
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    run = commands.add_parser('prepare')
    run.add_argument('--repo', default='.')
    run.add_argument('--output', required=True)
    run.add_argument('--mode', choices=['upstream', 'baseline'], default='upstream')
    run.add_argument('--force', action='store_true')
    install = commands.add_parser('restore')
    install.add_argument('--repo', default='.')
    install.add_argument('--bundle', required=True)
    install.add_argument('--sha', required=True)
    install.add_argument('--source', required=True)
    report = commands.add_parser('finish')
    report.add_argument('--output', required=True)
    report.add_argument('--ci-result', choices=['success', 'failure', 'cancelled', 'skipped'], required=True)
    args = parser.parse_args()
    if args.command == 'restore':
        restore(args.repo, args.bundle, args.sha, source=args.source)
        return
    if args.command == 'finish':
        write_report(args.output, finish(args.output, args.ci_result), emit=True)
        return
    if os.environ.get('GITHUB_ACTIONS') == 'true' and (
            os.environ.get('GITHUB_REPOSITORY') != REPOSITORY or os.environ.get('GITHUB_REF') != 'refs/heads/main'):
        raise SystemExit('upstream preparation is restricted to holeenlu/vm2api main')
    try:
        state = prepare(args.repo, args.output, mode=args.mode, force=args.force)
    except Exception as error:
        state = {'status': 'error', 'mode': args.mode, 'warnings': [str(error)]}
        write_report(args.output, state, emit=True)
        raise SystemExit(1) from error
    write_report(args.output, state, emit=True)


if __name__ == '__main__':
    main()
