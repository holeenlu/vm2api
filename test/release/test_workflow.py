"""Release dependencies and real archive/staging commands, without remote writes."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / '.github/workflows/release.yml').read_text()


def job(name):
    return re.search(rf'^  {re.escape(name)}:\n(.*?)(?=^  [\w-]+:\n|\Z)',
                     WORKFLOW, re.M | re.S)[1]


def script(name):
    step = re.search(rf'^      - name: {re.escape(name)}\n(.*?)(?=^      - |\Z)',
                     WORKFLOW, re.M | re.S)[1]
    body = step.split('        run: ', 1)[1]
    return textwrap.dedent(body[2:]) if body.startswith('|\n') else body.strip()


class ReleaseWorkflowTests(unittest.TestCase):
    def test_parallel_validation_branches_both_gate_image_and_publication(self):
        for name in ('checks', 'linux-amd64'):
            self.assertIn('    needs: prepare\n', job(name))
        self.assertIn('needs: [prepare, checks, linux-amd64]', job('image-amd64'))
        self.assertIn('needs: [prepare, image-amd64]', job('publish'))
        self.assertNotIn('always()', WORKFLOW)
        self.assertNotIn('continue-on-error:', WORKFLOW)
        self.assertIn("if: needs.prepare.outputs.publish == 'true'", job('publish'))
        image = job('image-amd64')
        self.assertLess(image.index('Smoke test'), image.index('Push verified image'))
        self.assertIn('cancel-in-progress: false', WORKFLOW)

    def test_each_frontend_and_go_check_runs_once_before_artifact_upload(self):
        checks, native = job('checks'), job('linux-amd64')
        self.assertEqual(WORKFLOW.count('          pnpm build\n'), 1)
        self.assertEqual(WORKFLOW.count('          pnpm test\n'), 1)
        self.assertEqual(WORKFLOW.count('go test ./...'), 2)
        self.assertLess(checks.index('pnpm build'), checks.index('name: release-web'))
        self.assertLess(native.index('go test'), native.index('go build'))
        self.assertLess(native.index('--check'), native.index('actions/upload-artifact'))
        self.assertIn('cache: npm', checks)
        self.assertIn('cache: true', checks)
        self.assertIn('cache_dependency_path: web/pnpm-lock.yaml', checks)
        self.assertIn('restore-keys:', native)
        self.assertIn("hashFiles('worker/go.sum', 'api-kernel/go.sum')", native)
        self.assertIn('mode=min', job('image-amd64'))
        self.assertNotIn('mode=max', job('image-amd64'))

    @unittest.skipUnless(shutil.which('node'), 'Node is required for payload staging')
    def test_artifact_roundtrip_preserves_image_paths_modes_and_asset_checksums(self):
        for corrupt in (False, True):
            with self.subTest(corrupt=corrupt), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / 'scripts').mkdir()
                shutil.copy2(ROOT / 'scripts/fetch-payload.mjs', root / 'scripts/fetch-payload.mjs')
                (root / 'deploy').mkdir()
                manifest = json.loads((ROOT / 'deploy/payload.json').read_text())
                source = root / 'build/release-native'
                payload = source / 'payload/payload'
                for item in manifest['files']:
                    data = item['asset'].encode()
                    item.update(size=len(data), sha256=hashlib.sha256(data).hexdigest())
                    path = payload / item['path']
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(data)
                    path.chmod(0o755)
                (root / 'deploy/payload.json').write_text(json.dumps(manifest))
                helpers = source / 'helpers/out'
                helpers.mkdir(parents=True)
                for name in ('kin-worker', 'kin-egress', 'kin-slot-gate', 'kin-api-kernel'):
                    (helpers / name).write_bytes(name.encode())
                    (helpers / name).chmod(0o755)
                if corrupt:
                    (payload / manifest['files'][0]['path']).write_bytes(b'corrupt')
                def execute(command, runner):
                    return subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', command],
                                          cwd=root, env={**os.environ, 'RUNNER_TEMP': str(runner)},
                                          capture_output=True, text=True)
                pack = next(line for line in script('Build native helpers and verify pinned payloads').splitlines()
                            if line.startswith('tar '))
                result = execute(pack, root / 'build')
                self.assertEqual(result.returncode, 0, result.stderr)
                for consumer in ('image', 'publish'):
                    runner = root / consumer
                    runner.mkdir()
                    shutil.copy2(root / 'build/linux-amd64.tar', runner / 'linux-amd64.tar')
                    name = 'Restore verified native build contexts' if consumer == 'image' else 'Stage verified release assets'
                    result = execute(script(name), runner)
                    if consumer == 'image':
                        self.assertEqual(result.returncode, 0, result.stderr)
                        result = execute(script('Verify restored payloads'), runner)
                        if corrupt:
                            self.assertNotEqual(result.returncode, 0)
                            self.assertIn('payload mismatch', result.stderr)
                            continue
                    if consumer == 'publish' and corrupt:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn('does not match the manifest', result.stderr)
                        continue
                    self.assertEqual(result.returncode, 0, result.stderr)
                    restored = runner / 'release-native'
                    for original in source.rglob('*'):
                        if original.is_file():
                            actual = restored / original.relative_to(source)
                            self.assertEqual(actual.read_bytes(), original.read_bytes())
                            self.assertEqual(actual.stat().st_mode & 0o777, 0o755)
                if not corrupt:
                    expected = {item['asset'] for item in manifest['files']} | {'kin-worker', 'kin-egress', 'kin-slot-gate'}
                    self.assertEqual({p.name for p in (root / 'release-assets').iterdir()}, expected)
                    for path in (root / 'release-assets').iterdir():
                        self.assertEqual(path.read_bytes(), path.name.encode())
                for name, directory in [('web', 'release-web'), ('helpers', 'release-native/helpers'), ('payload', 'release-native/payload')]:
                    self.assertIn(name + '=' + '$' + '{{ runner.temp }}/' + directory, job('image-amd64'))
                    self.assertIn(f'COPY --from={name} ', (ROOT / 'Dockerfile').read_text())
                image = job('image-amd64')
                self.assertLess(image.index('Verify restored payloads'), image.index('docker/build-push-action'))
