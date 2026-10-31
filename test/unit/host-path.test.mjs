import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import {
  buildHostMap,
  discoverSelfMounts,
  mapHostPath,
  parseMounts,
  resetHostPathCache,
  toHostPath,
} from '../../src/lib/vm/host-path.mjs'

const PROJECT = '/opt/tapmodels'

function mountsJson(pairs) {
  return JSON.stringify(pairs.map(([Source, Destination]) => ({ Source, Destination, Type: 'bind' })))
}

test('slot mounts resolve to host paths when the install dir is not /opt/tapmodels', () => {
  const entries = buildHostMap({ projectRoot: PROJECT, hostRoot: '/srv/stack/tapmodels' })
  assert.equal(mapHostPath('/opt/tapmodels/vms/vm-01/cli-home', entries), '/srv/stack/tapmodels/vms/vm-01/cli-home')
  assert.equal(mapHostPath('/opt/tapmodels/bin/kin-worker', entries), '/srv/stack/tapmodels/bin/kin-worker')
})

test('per-mount sources win over the project root, including named volumes', () => {
  const entries = buildHostMap({
    projectRoot: PROJECT,
    hostRoot: '/srv/stack/tapmodels',
    mounts: parseMounts(
      mountsJson([
        ['/var/lib/docker/volumes/tapmodels_vms/_data', '/opt/tapmodels/vms'],
        ['/srv/stack/tapmodels/bin', '/opt/tapmodels/bin'],
      ]),
    ),
  })
  assert.equal(
    mapHostPath('/opt/tapmodels/vms/vm-02/run', entries),
    '/var/lib/docker/volumes/tapmodels_vms/_data/vm-02/run',
  )
  assert.equal(mapHostPath('/opt/tapmodels/bin/kin-kernel', entries), '/srv/stack/tapmodels/bin/kin-kernel')
})

test('paths outside the project tree are never rewritten', () => {
  const entries = buildHostMap({ projectRoot: PROJECT, hostRoot: '/srv/stack/tapmodels' })
  assert.equal(mapHostPath('/var/run/docker.sock', entries), '/var/run/docker.sock')
  assert.equal(mapHostPath('/opt/tapmodels-other/data', entries), '/opt/tapmodels-other/data')
})

test('native deploy maps to itself when nothing is configured', () => {
  const entries = buildHostMap({ projectRoot: PROJECT })
  assert.equal(mapHostPath('/opt/tapmodels/vms/vm-01', entries), '/opt/tapmodels/vms/vm-01')
})

test('self-inspection skips containers that do not carry the project tree', () => {
  const seen = []
  const mounts = discoverSelfMounts({
    projectRoot: PROJECT,
    sockPath: fileURLToPath(import.meta.url), // any existing path: stands in for a mounted docker.sock
    names: ['not-us', 'tapmodels'],
    dockerJson: (name) => {
      seen.push(name)
      if (name === 'not-us') return mountsJson([['/elsewhere', '/srv/other']])
      return mountsJson([['/srv/stack/tapmodels/vms', '/opt/tapmodels/vms']])
    },
  })
  assert.deepEqual(seen.slice(0, 2), ['not-us', 'tapmodels'])
  assert.deepEqual(mounts, [{ source: '/srv/stack/tapmodels/vms', destination: '/opt/tapmodels/vms' }])
})

test('explicit host root env overrides discovery', () => {
  resetHostPathCache()
  const mapped = toHostPath('/opt/tapmodels/vms/vm-03/run', {
    projectRoot: PROJECT,
    env: { TAPMODELS_HOST_ROOT: '/data/tapmodels' },
    sockPath: '/nonexistent-docker-sock',
  })
  resetHostPathCache()
  assert.equal(mapped, '/data/tapmodels/vms/vm-03/run')
})
