import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('upstream_guard', ROOT / 'scripts/release/upstream_release_guard.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class UpstreamReleaseGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.upstream = self.commit('VERSION', '1.4.024')
        self.base = self.commit('custom.txt', 'old custom')

    def git(self, *args):
        return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
                                        *args], cwd=self.repo, text=True, stderr=subprocess.PIPE).strip()

    def commit(self, name, content):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        self.git('add', name)
        self.git('commit', '-m', content)
        return self.git('rev-parse', 'HEAD')

    def check(self, after, **event):
        return guard.decision(self.repo, 'push', {'before': self.base, 'after': after, **event}, after)[0]

    def new_release(self, value='1.4.025'):
        self.git('checkout', '--detach', self.upstream)
        upstream = self.commit('VERSION', value)
        return self.commit('custom.txt', 'new custom'), upstream

    def test_new_upstream_version_releases_even_on_forced_customization_rewrite(self):
        after, _ = self.new_release()
        self.assertTrue(self.check(after, forced=True))

    def test_same_version_local_or_guest_changes_never_release(self):
        after = self.commit('docker/kin-os/debian-12/Dockerfile', 'FROM debian:12')
        self.assertFalse(self.check(after))
        self.git('checkout', '--detach', self.upstream)
        after = self.commit('custom.txt', 'replacement custom')
        self.assertFalse(self.check(after, forced=True))

    def test_upstream_source_update_without_version_bump_does_not_release(self):
        self.git('checkout', '--detach', self.upstream)
        self.commit('source.txt', 'upstream code')
        after = self.commit('custom.txt', 'updated custom')
        self.assertFalse(self.check(after, forced=True))

    def test_local_version_bump_without_upstream_version_is_rejected(self):
        after = self.commit('VERSION', '1.4.025')
        with self.assertRaisesRegex(ValueError, 'inherited'):
            self.check(after)

    def test_version_rollback_does_not_release(self):
        after, _ = self.new_release('1.4.023')
        self.assertFalse(self.check(after, forced=True))

    def test_absent_history_and_initial_push_fail_closed(self):
        after, _ = self.new_release()
        for before in ['0' * 40, '--all', '']:
            with self.subTest(before=before):
                self.assertFalse(self.check(after, before=before))
        with self.assertRaises(subprocess.CalledProcessError):
            self.check(after, before='f' * 40)

    def test_mismatched_checkout_is_an_error(self):
        after, _ = self.new_release()
        self.git('checkout', '--detach', self.base)
        with self.assertRaisesRegex(ValueError, 'checkout'):
            self.check(after)

    def test_explicit_manual_run_preserves_publication(self):
        self.assertTrue(guard.decision(self.repo, 'workflow_dispatch', {}, self.base)[0])
        self.assertFalse(guard.decision(self.repo, 'pull_request', {}, self.base)[0])
