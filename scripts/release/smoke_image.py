"""Boot the exact release image without host mounts or production credentials."""
import json
from pathlib import Path
import subprocess
import sys
import uuid


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
    image = sys.argv[1]
    info = json.loads(run('docker', 'image', 'inspect', image))[0]
    if (info['Os'], info['Architecture']) != ('linux', 'amd64'):
        raise SystemExit('Expected linux/amd64 image')
    name = 'tapmodels-release-smoke-' + uuid.uuid4().hex[:10]
    try:
        run('docker', 'run', '-d', '--name', name, '--platform', 'linux/amd64', image)
        script = r'''
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
assert.equal(process.arch, 'x64');
assert.equal(fs.readFileSync('VERSION', 'utf8').trim(), process.argv[1]);
const base = 'http://127.0.0.1:8787';
let ready = false;
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
    if (res.ok) { ready = true; break; }
  } catch {}
  await setTimeout(1000);
}
assert.ok(ready, 'server readiness');
const site = await fetch(base + '/api/panel/site');
assert.equal(site.status, 200);
const body = await site.json();
assert.equal((body.data || body).name, 'tapmodels');
assert.equal((await fetch(base + '/console/')).status, 200);
assert.equal((await fetch(base + '/api/panel/me/profile')).status, 401);
for (const file of ['bin/kin-worker', 'bin/kin-egress', 'bin/kin-api-kernel', 'bin/kin-slot-gate']) {
  const header = fs.readFileSync(file).subarray(0, 20);
  assert.equal(header.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(header.readUInt16LE(18), 62, file + ' must be amd64');
}
console.log('PASS linux/amd64 startup, version, public branding, console and profile authorization');
'''
        print(run('docker', 'exec', name, 'node', '--input-type=module', '-e', script,
                  Path('VERSION').read_text().strip()))
    finally:
        subprocess.run(['docker', 'rm', '-fv', name], stdout=subprocess.DEVNULL, check=False)


if __name__ == '__main__':
    main()
