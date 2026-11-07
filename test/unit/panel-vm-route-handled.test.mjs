import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createPanelVmImportRoutes } from '../../src/lib/admin/panel-vm-import-routes.mjs'
import { createPanelVmPackageRoutes } from '../../src/lib/admin/panel-vm-package-routes.mjs'
import { createPanelVmProvisionRoutes } from '../../src/lib/admin/panel-vm-provision-routes.mjs'
import { createPanelVmResetRoutes } from '../../src/lib/admin/panel-vm-reset-routes.mjs'
import { createPanelVmSeedRoutes } from '../../src/lib/admin/panel-vm-seed-routes.mjs'

// panel-routes 按 `if (await handler(req, res, p)) return true` 串联子处理器；处理器写完响应必须返回真值，
// 否则请求会继续匹配后面的路由，最后走到面板 404 再写一次响应头。json 与真实实现一样不返回值。
function harness() {
  const responses = []
  const json = (_res, status, body) => {
    responses.push({ status, body })
  }
  return { responses, json }
}

const cfg = { paths: { project: '/nonexistent-project' } }
const fsMissing = { existsSync: () => false }
const req = (method, url = '/') => ({ method, url, headers: {} })

test('VM import route reports a written response as handled', async () => {
  const { responses, json } = harness()
  const handle = createPanelVmImportRoutes({ cfg, json, readBody: async () => ({}) })
  assert.equal(await handle(req('POST'), {}, '/api/panel/vms/import'), true)
  assert.equal(responses[0].status, 400)
})

test('VM import rejects a vm_id that is not a slot id before touching the file system', async () => {
  const { responses, json } = harness()
  let checked = 0
  const touched = []
  const handle = createPanelVmImportRoutes({
    cfg,
    path,
    json,
    fs: { existsSync: (file) => touched.push(file) && false },
    readBody: async () => ({ vm_id: '../../config/runtime-secrets' }),
    assertVendorRuntimeVm: async () => {
      checked++
    },
  })
  assert.equal(await handle(req('POST'), {}, '/api/panel/vms/import'), true)
  assert.equal(responses[0].status, 400)
  assert.equal(responses[0].body.error.code, 'invalid_vm_id')
  assert.deepEqual(touched, [])
  assert.equal(checked, 0)
})

test('VM package route reports a written response as handled', async () => {
  const { responses, json } = harness()
  const handle = createPanelVmPackageRoutes({
    cfg,
    json,
    exportVmPackage: () => ({ ok: false, status: 404, error: { message: 'vm not found' } }),
  })
  assert.equal(await handle(req('GET'), {}, '/api/panel/vms/vm-01/package'), true)
  assert.equal(responses[0].status, 404)
})

test('VM provision route reports a written response as handled', async () => {
  const { responses, json } = harness()
  const handle = createPanelVmProvisionRoutes({
    cfg,
    path,
    json,
    readBody: async () => ({ id: 'bad' }),
    listVms: () => [],
    newVmNaming: () => ({ index: 1, id: 'vm-01' }),
    isValidVmId: () => false,
  })
  assert.equal(await handle(req('POST'), {}, '/api/panel/vms/create'), true)
  assert.equal(responses[0].status, 400)
})

test('VM reset route reports a written response as handled', async () => {
  const { responses, json } = harness()
  const handle = createPanelVmResetRoutes({ cfg, json, fs: fsMissing, path })
  assert.equal(await handle(req('POST'), {}, '/api/panel/vms/vm-01/reset'), true)
  assert.equal(responses[0].status, 404)
})

test('VM seed route reports a written response as handled', async () => {
  const { responses, json } = harness()
  const handle = createPanelVmSeedRoutes({ cfg, json, fs: fsMissing, path, getVm: () => null })
  assert.equal(await handle(req('GET'), {}, '/api/panel/vms/vm-01/seed-settings'), true)
  assert.equal(await handle(req('PUT'), {}, '/api/panel/vms/vm-01/seed-settings'), true)
  assert.deepEqual(
    responses.map((item) => item.status),
    [404, 404],
  )
})
