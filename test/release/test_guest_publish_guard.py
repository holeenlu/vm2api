import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('guest_guard', ROOT / 'scripts/release/guest_publish_guard.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class GuestPublishGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.base = self.commit('readme.md', 'initial')

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

    def test_normal_source_change_publishes_but_unrelated_change_does_not(self):
        unrelated = self.commit('readme.md', 'docs only')
        self.assertFalse(self.check(unrelated))
        image = self.commit('docker/kin-os/debian-12/Dockerfile', 'FROM debian:12')
        self.assertTrue(self.check(image))

    def test_forced_push_never_publishes_even_when_guest_sources_change(self):
        after = self.commit('docker/kin-kvm/Dockerfile', 'FROM scratch')
        self.assertFalse(self.check(after, forced=True))

    def test_rewritten_customization_is_rejected_even_without_forced_flag(self):
        old = self.commit('custom.txt', 'old custom')
        self.git('checkout', '--detach', self.base)
        new = self.commit('docker/kin-kvm/Dockerfile', 'replacement custom')
        self.base = old
        self.assertFalse(self.check(new, forced=False))

    def test_absent_history_and_initial_push_fail_closed(self):
        after = self.git('rev-parse', 'HEAD')
        for before in ['0' * 40, 'f' * 40, '--all', '']:
            with self.subTest(before=before):
                self.assertFalse(self.check(after, before=before))

    def test_mismatched_checkout_is_an_error(self):
        after = self.commit('readme.md', 'new')
        self.git('checkout', '--detach', self.base)
        with self.assertRaisesRegex(ValueError, 'checkout'):
            self.check(after)

    def test_explicit_manual_run_preserves_publication(self):
        self.assertTrue(guard.decision(self.repo, 'workflow_dispatch', {}, self.base)[0])
        self.assertFalse(guard.decision(self.repo, 'pull_request', {}, self.base)[0])
