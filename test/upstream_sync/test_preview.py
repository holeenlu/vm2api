import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('upstream_preview', ROOT / 'scripts/upstream-sync/preview.py')
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


def git(repo, *args):
    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null',
                                    '-c', 'commit.gpgsign=false', *args], cwd=repo,
                                   text=True, stderr=subprocess.PIPE).strip()


class PreviewIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.upstream = self.root / 'upstream'
        self.local = self.root / 'local'
        self.output = self.root / 'report'
        self.upstream.mkdir()
        git(self.upstream, 'init', '-b', 'main')
        self.identity(self.upstream)
        self.write(self.upstream, 'shared.txt', 'common\n')
        self.write(self.upstream, 'CHANGELOG.md', '# Changelog\n\n## 1.0.0 — 2026-10-20\n\n- Original history.\n')
        self.write(self.upstream, 'docs/contract.md', 'private commercial contract\n')
        self.write(self.upstream, 'test/contract.test.mjs', '// fixture\n')
        self.write(self.upstream, 'src/lib/db/migrations/001_initial.sql', 'CREATE TABLE fixture(id TEXT);\n')
        contracts = {'version': 1, 'features': [{'id': 'fixture-feature',
            'requirements': ['docs/contract.md'], 'paths': ['feature/*', 'docker/*'],
            'unit_tests': ['test/contract.test.mjs'], 'e2e_tests': []}]}
        self.write(self.upstream, 'scripts/upstream-sync/contracts.json', json.dumps(contracts))
        self.commit(self.upstream, 'common baseline')
        git(self.root, 'clone', str(self.upstream), str(self.local))
        self.identity(self.local)

    def identity(self, repo):
        git(repo, 'config', 'user.name', 'fixture')
        git(repo, 'config', 'user.email', 'fixture@example.invalid')

    def write(self, repo, name, text):
        p = repo / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def commit(self, repo, message):
        git(repo, 'add', '--all')
        git(repo, 'commit', '-m', message)
        return git(repo, 'rev-parse', 'HEAD')

    def prepare(self, **kwargs):
        kwargs.setdefault('lookup', lambda *_: None)
        return preview.prepare(self.local, self.output, source_url=str(self.upstream), **kwargs)

    def upstream_change(self, name='feature/fix.txt', text='upstream fix\n'):
        self.write(self.upstream, name, text)
        return self.commit(self.upstream, 'upstream change')

    def test_no_updates_never_creates_empty_merge_or_bundle(self):
        before = git(self.local, 'rev-parse', 'HEAD')
        result = self.prepare()
        self.assertEqual(result['status'], 'up_to_date')
        self.assertFalse((self.output / 'candidate.bundle').exists())
        self.assertEqual(git(self.local, 'rev-parse', 'HEAD'), before)

    def test_non_utf8_conflict_patch_is_preserved_without_decoding(self):
        (self.local / 'shared.txt').write_bytes(b'local\xff\n')
        self.commit(self.local, 'local byte change')
        (self.upstream / 'shared.txt').write_bytes(b'upstream\xfe\n')
        self.commit(self.upstream, 'upstream byte change')
        result = self.prepare()
        self.assertEqual(result['status'], 'conflicts')
        patch_bytes = (self.output / 'conflicts.patch').read_bytes()
        self.assertIn(b'local\xff', patch_bytes)
        self.assertIn(b'upstream\xfe', patch_bytes)

    def test_temporary_clone_finishes_without_background_maintenance(self):
        self.upstream_change()
        trace = self.root / 'git-trace.jsonl'
        env = {'GIT_TRACE2_EVENT': str(trace), 'GIT_CONFIG_COUNT': '4',
               'GIT_CONFIG_KEY_0': 'maintenance.auto', 'GIT_CONFIG_VALUE_0': 'true',
               'GIT_CONFIG_KEY_1': 'maintenance.strategy', 'GIT_CONFIG_VALUE_1': 'incremental',
               'GIT_CONFIG_KEY_2': 'maintenance.loose-objects.auto', 'GIT_CONFIG_VALUE_2': '1',
               'GIT_CONFIG_KEY_3': 'maintenance.autoDetach', 'GIT_CONFIG_VALUE_3': 'true'}
        with patch.dict(os.environ, env), patch.object(tempfile, 'tempdir', str(self.root)):
            result = self.prepare()
        self.assertEqual(result['status'], 'candidate_ready')
        self.assertEqual(list(self.root.glob('tapmodels-upstream-preview-*')), [])
        events = [json.loads(line) for line in trace.read_text().splitlines()]
        maintenance = [event.get('argv') for event in events if event.get('event') == 'child_start'
                       and any(arg in ('maintenance', 'gc') for arg in event.get('argv', []))]
        self.assertEqual(maintenance, [], 'temporary repositories must not launch maintenance workers')

    def test_changelog_conflict_uses_exact_upstream_and_preserves_custom_notes(self):
        self.write(self.local, 'CHANGELOG.md', '# Local replacement\n')
        self.write(self.local, 'docs/CUSTOMIZATION_RELEASE_NOTES.md', 'Local features remain documented.\n')
        self.commit(self.local, 'local changelog customization')
        upstream_text = '# Changelog\n\n## 1.0.1 — 2026-10-21\n\n- New entry.\n\n## 1.0.0 — 2026-10-20\n\n- Original history.\n'
        source = self.upstream_change('CHANGELOG.md', upstream_text)
        result = self.prepare()
        self.assertEqual(result['status'], 'candidate_ready')
        self.assertEqual(result['changelog_blob'], git(self.upstream, 'rev-parse', 'HEAD:CHANGELOG.md'))
        preview.restore(self.local, self.output / 'candidate.bundle', result['candidate_sha'], source=source)
        self.assertEqual((self.local / 'CHANGELOG.md').read_text(), upstream_text)
        self.assertEqual((self.local / 'docs/CUSTOMIZATION_RELEASE_NOTES.md').read_text(), 'Local features remain documented.\n')

    def test_changelog_drift_is_repaired_even_without_new_upstream_commits(self):
        for deleted in (False, True):
            with self.subTest(deleted=deleted):
                if deleted:
                    (self.local / 'CHANGELOG.md').unlink()
                else:
                    self.write(self.local, 'CHANGELOG.md', 'Local-only history\n')
                self.commit(self.local, 'changelog drift')
                result = self.prepare()
                self.assertEqual(result['status'], 'candidate_ready')
                preview.restore(self.local, self.output / 'candidate.bundle', result['candidate_sha'], source=result['source_sha'])
                self.assertEqual((self.local / 'CHANGELOG.md').read_bytes(), (self.upstream / 'CHANGELOG.md').read_bytes())
                self.assertEqual(self.prepare()['status'], 'up_to_date')

    def test_changelog_resolution_does_not_hide_business_conflicts(self):
        self.write(self.local, 'CHANGELOG.md', 'local history\n')
        self.write(self.local, 'shared.txt', 'local choice\n')
        self.commit(self.local, 'local changes')
        self.write(self.upstream, 'CHANGELOG.md', 'upstream history\n')
        self.upstream_change('shared.txt', 'upstream choice\n')
        result = self.prepare()
        self.assertEqual(result['status'], 'conflicts')
        self.assertEqual(result['conflicts'], ['shared.txt'])
        self.assertFalse((self.output / 'candidate.bundle').exists())

    def test_clean_merge_also_removes_local_changelog_edits(self):
        self.write(self.local, 'CHANGELOG.md', 'Outdated local history\n')
        self.commit(self.local, 'local changelog')
        source = self.upstream_change()
        result = self.prepare()
        self.assertEqual(result['status'], 'candidate_ready')
        preview.restore(self.local, self.output / 'candidate.bundle', result['candidate_sha'], source=source)
        self.assertEqual((self.local / 'CHANGELOG.md').read_bytes(), (self.upstream / 'CHANGELOG.md').read_bytes())
        self.assertEqual((self.local / 'feature/fix.txt').read_text(), 'upstream fix\n')

    def test_missing_or_symlink_upstream_changelog_blocks_instead_of_keeping_stale_history(self):
        path = self.upstream / 'CHANGELOG.md'
        path.unlink()
        self.commit(self.upstream, 'remove changelog')
        with self.assertRaisesRegex(ValueError, 'CHANGELOG.md must be a regular tracked file'):
            self.prepare()
        path.symlink_to('shared.txt')
        self.commit(self.upstream, 'replace changelog with symlink')
        with self.assertRaisesRegex(ValueError, 'CHANGELOG.md must be a regular tracked file'):
            self.prepare()

    def test_clean_merge_becomes_one_customization_on_upstream_and_restores_exact_tree(self):
        self.write(self.local, 'custom.txt', 'local requirement\n')
        base = self.commit(self.local, 'customization')
        source = self.upstream_change()
        result = self.prepare()
        self.assertEqual(result['status'], 'candidate_ready')
        self.assertEqual(result['base_sha'], base)
        self.assertEqual(result['source_sha'], source)
        self.assertEqual(result['features'][0]['id'], 'fixture-feature')
        self.assertEqual(git(self.local, 'rev-parse', 'HEAD'), base)
        self.assertEqual(git(self.upstream, 'rev-parse', 'HEAD'), source)
        restored = self.root / 'restored'
        git(self.root, 'clone', '--depth', '1', self.local.as_uri(), str(restored))
        preview.restore(restored, self.output / 'candidate.bundle', result['candidate_sha'], source=result['source_sha'])
        self.assertEqual(git(restored, 'show', '-s', '--format=%P', 'HEAD').split(), [source])
        self.assertEqual(git(restored, 'rev-parse', 'HEAD^{tree}'), result['candidate_tree'])
        self.assertEqual(git(restored, 'rev-list', '--count', f'{source}..HEAD'), '1')
        self.assertNotIn(base, git(restored, 'rev-list', 'HEAD').splitlines())
        self.assertEqual((restored / 'custom.txt').read_text(), 'local requirement\n')
        self.assertEqual((restored / 'feature/fix.txt').read_text(), 'upstream fix\n')

    def test_successive_syncs_keep_latest_custom_tree_without_old_custom_history(self):
        self.write(self.local, 'custom.txt', 'first local requirement\n')
        retired = [self.commit(self.local, 'first customization')]
        self.write(self.local, 'obsolete.txt', 'later removed\n')
        retired.append(self.commit(self.local, 'old follow-up customization'))
        for round_number in (1, 2):
            if round_number == 2:
                (self.local / 'obsolete.txt').unlink()
                self.write(self.local, 'custom.txt', 'updated local requirement\n')
                git(self.local, 'add', 'custom.txt', 'obsolete.txt')
                git(self.local, 'commit', '--amend', '-m', 'updated customization')
                retired.append(git(self.local, 'rev-parse', 'HEAD'))
            source = self.upstream_change(f'feature/fix-{round_number}.txt')
            result = self.prepare()
            self.assertEqual(result['status'], 'candidate_ready')
            preview.restore(self.local, self.output / 'candidate.bundle', result['candidate_sha'], source=source)
            self.assertEqual(git(self.local, 'rev-list', '--count', f'{source}..HEAD'), '1')
            self.assertEqual(git(self.local, 'show', '-s', '--format=%P', 'HEAD'), source)
            history = git(self.local, 'rev-list', 'HEAD').splitlines()
            self.assertTrue(all(old not in history for old in retired))
            retired.append(result['candidate_sha'])
            git(self.local, 'checkout', '-B', 'main')
        self.assertEqual((self.local / 'custom.txt').read_text(), 'updated local requirement\n')
        self.assertFalse((self.local / 'obsolete.txt').exists())
        self.assertTrue((self.local / 'feature/fix-1.txt').is_file())
        self.assertTrue((self.local / 'feature/fix-2.txt').is_file())

    def test_dirty_caller_index_and_untracked_files_are_not_copied_or_modified(self):
        self.upstream_change()
        self.write(self.local, 'shared.txt', 'unstaged work\n')
        self.write(self.local, 'staged.txt', 'staged work\n')
        git(self.local, 'add', 'staged.txt')
        self.write(self.local, 'untracked.txt', 'private work\n')
        status = git(self.local, 'status', '--porcelain')
        index = git(self.local, 'write-tree')
        result = self.prepare()
        self.assertEqual(result['status'], 'candidate_ready')
        self.assertEqual(git(self.local, 'status', '--porcelain'), status)
        self.assertEqual(git(self.local, 'write-tree'), index)
        self.assertEqual((self.local / 'shared.txt').read_text(), 'unstaged work\n')

    def test_conflict_preserves_input_bundle_without_a_candidate(self):
        self.write(self.local, 'shared.txt', 'local choice\n')
        base = self.commit(self.local, 'local choice')
        self.upstream_change('shared.txt', 'upstream choice\n')
        result = self.prepare()
        self.assertEqual(result['status'], 'conflicts')
        self.assertEqual(result['conflicts'], ['shared.txt'])
        self.assertTrue((self.output / 'inputs.bundle').is_file())
        self.assertFalse((self.output / 'candidate.bundle').exists())
        self.assertEqual(git(self.local, 'rev-parse', 'HEAD'), base)
        self.assertEqual((self.local / 'shared.txt').read_text(), 'local choice\n')

    def test_migration_number_collision_blocks_even_when_git_merges_cleanly(self):
        self.write(self.local, 'src/lib/db/migrations/002_local.sql', 'SELECT 1;\n')
        self.commit(self.local, 'local migration')
        self.upstream_change('src/lib/db/migrations/002_upstream.sql', 'SELECT 2;\n')
        result = self.prepare()
        self.assertEqual(result['status'], 'contracts_blocked')
        self.assertTrue(any('duplicate migration' in issue for issue in result['blockers']))
        self.assertTrue((self.output / 'candidate.patch').is_file())
        self.assertFalse((self.output / 'candidate.bundle').exists())

    def test_historical_migration_modification_blocks(self):
        self.upstream_change('src/lib/db/migrations/001_initial.sql', 'CREATE TABLE changed(id TEXT);\n')
        result = self.prepare()
        self.assertEqual(result['status'], 'contracts_blocked')
        self.assertTrue(any('applied migration changed' in issue for issue in result['blockers']))

    def test_historical_migration_deletion_blocks(self):
        (self.upstream / 'src/lib/db/migrations/001_initial.sql').unlink()
        self.commit(self.upstream, 'remove migration')
        self.assertEqual(self.prepare()['status'], 'contracts_blocked')

    def test_new_migration_after_local_history_is_accepted(self):
        self.upstream_change('src/lib/db/migrations/002_next.sql', 'CREATE TABLE next(id TEXT);\n')
        self.assertEqual(self.prepare()['status'], 'candidate_ready')

    def test_deleting_protected_regression_cannot_silently_shrink_coverage(self):
        (self.upstream / 'test/contract.test.mjs').unlink()
        self.commit(self.upstream, 'remove protected test')
        result = self.prepare()
        self.assertEqual(result['status'], 'contracts_blocked')
        self.assertTrue(any('test/contract.test.mjs' in issue for issue in result['blockers']))

    def test_symlink_cannot_replace_protected_contract_reference(self):
        p = self.upstream / 'test/contract.test.mjs'
        p.unlink()
        p.symlink_to('../shared.txt')
        self.commit(self.upstream, 'replace test with symlink')
        self.assertEqual(self.prepare()['status'], 'contracts_blocked')

    def test_old_completed_result_deduplicates_but_does_not_claim_current_validation(self):
        self.upstream_change()
        old = {'run_id': 123, 'conclusion': 'failure', 'url': 'https://example.invalid/123'}
        result = self.prepare(lookup=lambda *_: old)
        self.assertEqual(result['status'], 'already_checked')
        self.assertEqual(result['previous']['conclusion'], 'failure')
        self.assertNotIn('candidate_sha', result)
        self.assertEqual(preview.output_values(result)['record'], 'false')

    def test_force_bypasses_prior_result(self):
        self.upstream_change()
        result = self.prepare(force=True, lookup=lambda *_: self.fail('must not use history when forced'))
        self.assertEqual(result['status'], 'candidate_ready')

    def test_history_api_failure_rechecks_instead_of_skipping(self):
        self.upstream_change()
        def fail(*_):
            raise RuntimeError('API unavailable')
        result = self.prepare(lookup=fail)
        self.assertEqual(result['status'], 'candidate_ready')
        self.assertIn('API unavailable', result['warnings'][0])

    def test_baseline_mode_never_merges_pending_upstream(self):
        self.write(self.local, 'CHANGELOG.md', 'Local baseline history\n')
        self.commit(self.local, 'local baseline')
        base = git(self.local, 'rev-parse', 'HEAD')
        self.upstream_change('CHANGELOG.md', 'Pending upstream history\n')
        result = self.prepare(mode='baseline', lookup=lambda *_: self.fail('baseline must not deduplicate'))
        self.assertEqual(result['candidate_sha'], base)
        self.assertEqual(result['mode'], 'baseline')
        preview.restore(self.local, self.output / 'candidate.bundle', base, source=result['source_sha'])
        self.assertEqual(git(self.local, 'rev-parse', 'HEAD'), base)
        self.assertFalse((self.local / 'feature/fix.txt').exists())
        self.assertEqual((self.local / 'CHANGELOG.md').read_text(), 'Local baseline history\n')

    def test_unreachable_source_is_not_reported_as_no_updates(self):
        with self.assertRaisesRegex(RuntimeError, 'git failed'):
            preview.prepare(self.local, self.output, source_url=str(self.root / 'absent'))
        self.assertFalse((self.output / 'candidate.bundle').exists())

    def test_guest_image_changes_are_explicitly_reported(self):
        name = 'docker/kin-kvm/Dockerfile'
        self.upstream_change(name, 'FROM scratch\n')
        result = self.prepare()
        self.assertEqual(result['side_effect_paths'], [name])
        self.assertIn(name, result['sensitive_paths'])
        self.assertEqual(git(self.local, 'status', '--porcelain'), '')

    def test_restore_rejects_mismatched_sha_before_checkout(self):
        self.upstream_change()
        result = self.prepare()
        base = git(self.local, 'rev-parse', 'HEAD')
        with self.assertRaisesRegex(ValueError, 'does not match'):
            preview.restore(self.local, self.output / 'candidate.bundle', 'a' * 40, source=result['source_sha'])
        self.assertEqual(git(self.local, 'rev-parse', 'HEAD'), base)
        self.assertNotEqual(result['candidate_sha'], base)

    def test_restore_rejects_candidate_with_stale_changelog(self):
        base = git(self.local, 'rev-parse', 'HEAD')
        source = self.upstream_change('CHANGELOG.md', 'New upstream history\n')
        git(self.local, 'fetch', str(self.upstream), source)
        tree = git(self.local, 'rev-parse', 'HEAD^{tree}')
        candidate = git(self.local, 'commit-tree', tree, '-p', source, '-m',
                        f'Preview with stale history\n\nPreview-Base: {base}\n')
        git(self.local, 'update-ref', preview.CANDIDATE_REF, candidate)
        bundle = self.root / 'stale.bundle'
        git(self.local, 'bundle', 'create', str(bundle), preview.CANDIDATE_REF)
        with self.assertRaisesRegex(ValueError, 'CHANGELOG.md differs from frozen upstream'):
            preview.restore(self.local, bundle, candidate, source=source)
        self.assertEqual(git(self.local, 'rev-parse', 'HEAD'), base)

    def test_restore_rejects_dirty_checkout(self):
        self.upstream_change()
        result = self.prepare()
        self.write(self.local, 'private.txt', 'do not overwrite\n')
        with self.assertRaisesRegex(ValueError, 'clean runner'):
            preview.restore(self.local, self.output / 'candidate.bundle', result['candidate_sha'], source=result['source_sha'])
        self.assertEqual((self.local / 'private.txt').read_text(), 'do not overwrite\n')

    def test_restore_rejects_candidate_for_another_baseline(self):
        self.upstream_change()
        result = self.prepare()
        self.write(self.local, 'new-local.txt', 'another task\n')
        base = self.commit(self.local, 'another task')
        with self.assertRaisesRegex(ValueError, 'workflow baseline'):
            preview.restore(self.local, self.output / 'candidate.bundle', result['candidate_sha'], source=result['source_sha'])
        self.assertEqual(git(self.local, 'rev-parse', 'HEAD'), base)

    def test_restore_rejects_another_upstream_source(self):
        self.upstream_change()
        result = self.prepare()
        base = git(self.local, 'rev-parse', 'HEAD')
        with self.assertRaisesRegex(ValueError, 'baseline/source'):
            preview.restore(self.local, self.output / 'candidate.bundle', result['candidate_sha'], source=base)
        self.assertEqual(git(self.local, 'rev-parse', 'HEAD'), base)

    def test_restore_rejects_old_two_parent_merge_shape(self):
        self.write(self.local, 'custom.txt', 'local customization\n')
        base = self.commit(self.local, 'customization')
        source = self.upstream_change()
        git(self.local, 'fetch', str(self.upstream), 'main')
        merge = git(self.local, 'commit-tree', 'HEAD^{tree}', '-p', base, '-p', source,
                    '-m', f'Preview-Base: {base}')
        git(self.local, 'update-ref', preview.CANDIDATE_REF, merge)
        bundle = self.root / 'old-merge.bundle'
        git(self.local, 'bundle', 'create', str(bundle), preview.CANDIDATE_REF)
        with self.assertRaisesRegex(ValueError, 'single customization'):
            preview.restore(self.local, bundle, merge, source=source)
        self.assertEqual(git(self.local, 'rev-parse', 'HEAD'), base)


class ContractAndReportTests(unittest.TestCase):
    def test_real_contract_references_exist(self):
        self.assertGreaterEqual(len(preview.load_contracts(ROOT)['features']), 5)

    def test_finish_never_turns_skipped_ci_into_validation(self):
        for ci in ['failure', 'cancelled', 'skipped']:
            with self.subTest(ci=ci), tempfile.TemporaryDirectory() as temp:
                preview.write_report(temp, {'status': 'candidate_ready'})
                self.assertEqual(preview.finish(temp, ci)['status'], 'ci_failed')

    def test_conflicts_remain_blocked_even_if_a_ci_result_is_success(self):
        with tempfile.TemporaryDirectory() as temp:
            preview.write_report(temp, {'status': 'conflicts', 'conflicts': ['shared.txt']})
            state = preview.finish(temp, 'success')
            self.assertEqual(state['status'], 'conflicts')
            self.assertEqual(preview.output_values(state)['should_fail'], 'true')

    def test_validated_report_is_explicitly_not_publication(self):
        with tempfile.TemporaryDirectory() as temp:
            preview.write_report(temp, {'status': 'candidate_ready'})
            state = preview.finish(temp, 'success')
            preview.write_report(temp, state)
            self.assertEqual(state['status'], 'validated')
            self.assertIn('未更新 main', (Path(temp) / 'report.md').read_text())

    def test_output_sha_rejects_shell_or_ref_syntax(self):
        for value in ['main', 'a' * 39, 'A' * 40, 'a' * 40 + '\nkey=value', '--all']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                preview.sha(value)

    def test_wrong_repository_cannot_prepare_from_actions(self):
        with tempfile.TemporaryDirectory() as temp:
            env = {**os.environ, 'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': 'dofastted/vm2api',
                   'GITHUB_REF': 'refs/heads/main'}
            result = subprocess.run(['python3', str(ROOT / 'scripts/upstream-sync/preview.py'),
                                     'prepare', '--output', temp], env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('restricted', result.stderr)
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_workflow_keeps_preview_read_only_and_uses_trusted_reusable_ci(self):
        flow = (ROOT / '.github/workflows/upstream-sync.yml').read_text()
        ci = (ROOT / '.github/workflows/test.yml').read_text()
        self.assertIn("cron: '17,47 * * * *'", flow)
        self.assertIn("github.repository == 'holeenlu/vm2api'", flow)
        self.assertIn('uses: ./.github/workflows/test.yml', flow)
        self.assertIn('cancel-in-progress: false', flow)
        self.assertNotIn('secrets: inherit', flow)
        for forbidden in ['contents: write', 'packages: write', 'pull-requests: write', 'git push', 'gh workflow run']:
            self.assertNotIn(forbidden, flow)
        self.assertIn('workflow_call:', ci)
        self.assertEqual(ci.count('preview.py restore --bundle'), 5)
        self.assertEqual(ci.count('persist-credentials: false'), 6)


class PreviousResultTests(unittest.TestCase):
    def test_only_completed_expected_workflow_at_same_baseline_deduplicates(self):
        base = 'b' * 40
        artifacts = {'artifacts': [
            {'expired': True, 'workflow_run': {'id': 1, 'head_sha': base}},
            {'expired': False, 'workflow_run': {'id': 2, 'head_sha': 'c' * 40}},
            {'expired': False, 'workflow_run': {'id': 3, 'head_sha': base}},
            {'expired': False, 'workflow_run': {'id': 4, 'head_sha': base}},
        ]}
        calls = []
        def response(*args):
            calls.append(args[-1])
            payload = artifacts if 'artifacts?' in args[-1] else {
                'path': '.github/workflows/upstream-sync.yml',
                'status': 'in_progress' if args[-1].endswith('/3') else 'completed', 'conclusion': 'failure'}
            return subprocess.CompletedProcess(args, 0, json.dumps(payload), '')
        with patch.dict(os.environ, {'GH_TOKEN': 'fixture', 'GITHUB_REPOSITORY': preview.REPOSITORY,
                                     'GITHUB_RUN_ID': '5'}), patch.object(preview, 'command', side_effect=response):
            result = preview.previous_result(base, 'fixture-artifact')
        self.assertEqual(result['run_id'], 4)
        self.assertEqual(result['conclusion'], 'failure')
        self.assertEqual(len(calls), 3)


if __name__ == '__main__':
    unittest.main()
