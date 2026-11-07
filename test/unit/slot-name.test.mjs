import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applySlotNameFromAuthorization,
  backfillSlotNames,
  resolveSlotName,
  slotAuthorizationEmail,
  takenSlotNames,
} from '../../src/lib/vm/slot-name.mjs'

function root(vms = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-name-'))
  fs.mkdirSync(path.join(dir, 'vms'))
  for (const [id, vm] of Object.entries(vms)) {
    fs.writeFileSync(path.join(dir, 'vms', `${id}.json`), JSON.stringify({ id, ...vm }))
  }
  return dir
}

const readVm = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, 'vms', `${id}.json`), 'utf8'))

test('resolveSlotName keeps the whole authorization email', () => {
  assert.equal(resolveSlotName(' Alice.Smith+tag@gmail.com ', new Set()), 'Alice.Smith+tag@gmail.com')
  assert.equal(resolveSlotName('', new Set()), '')
  assert.equal(resolveSlotName(null, new Set()), '')
  // 大小写不同也算同一个名字
  assert.equal(resolveSlotName('Abc@gmail.com', new Set(['abc@gmail.com'])), '')
})

test('slotAuthorizationEmail reads Claude and GPT slots', () => {
  assert.equal(slotAuthorizationEmail({ claude: { email: 'c@example.test' } }), 'c@example.test')
  assert.equal(slotAuthorizationEmail({ codex: { email: 'g@example.test' } }), 'g@example.test')
  assert.equal(slotAuthorizationEmail({ email: ' top@example.test ' }), 'top@example.test')
  assert.equal(slotAuthorizationEmail({}), '')
})

test('a slot named on creation is never renamed by an authorization', () => {
  const dir = root({ 'vm-01': { name: 'billing-prod' } })
  const vm = { id: 'vm-01', name: 'billing-prod' }
  assert.equal(applySlotNameFromAuthorization(dir, vm, 'abc@gmail.com'), false)
  assert.equal(vm.name, 'billing-prod')
})

test('a blank name becomes the authorization email once the slot is authorized', () => {
  const dir = root({ 'vm-01': { name: 'vm-01', name_from_authorization: true } })
  const vm = { id: 'vm-01', name: 'vm-01', name_from_authorization: true }
  assert.equal(applySlotNameFromAuthorization(dir, vm, ' abc@gmail.com '), true)
  assert.equal(vm.name, 'abc@gmail.com')
  assert.equal(vm.name_from_authorization, undefined)
})

test('two slots on the same mailbox keep different names: the later one stays a placeholder', () => {
  const dir = root({
    'vm-01': { name: 'abc@gmail.com' },
    'vm-02': { name: 'vm-02', name_from_authorization: true },
  })
  const vm = { id: 'vm-02', name: 'vm-02', name_from_authorization: true }
  assert.equal(applySlotNameFromAuthorization(dir, vm, 'abc@gmail.com'), false)
  assert.equal(vm.name, 'vm-02')
  // 标记保留：下一次换个邮箱授权还能定名
  assert.equal(vm.name_from_authorization, true)
})

test('a different mailbox on the same provider still names the slot', () => {
  const dir = root({
    'vm-01': { name: 'abc@gmail.com' },
    'vm-02': { name: 'vm-02', name_from_authorization: true },
  })
  const vm = { id: 'vm-02', name: 'vm-02', name_from_authorization: true }
  assert.equal(applySlotNameFromAuthorization(dir, vm, 'abc@outlook.com'), true)
  assert.equal(vm.name, 'abc@outlook.com')
})

test('takenSlotNames covers other slots by id and name, never itself', () => {
  const dir = root({ 'vm-01': { name: 'abc@gmail.com' }, 'vm-02': { name: 'vm-02' } })
  const taken = takenSlotNames(dir, 'vm-02')
  assert.equal(taken.has('abc@gmail.com'), true)
  assert.equal(taken.has('vm-01'), true)
  assert.equal(taken.has('vm-02'), false)
})

test('backfill renames auto-numbered slots and leaves everything else alone', () => {
  const dir = root({
    // 自动编号 + 已授权：改名
    'vm-01': { name: 'vm-01', claude: { email: 'alice@gmail.com' } },
    // 人工命名：不动
    'vm-02': { name: 'billing-prod', claude: { email: 'bob@gmail.com' } },
    // 未授权：保持编号
    'vm-03': { name: 'vm-03' },
    // 供应商账号的运行环境：命名规则不变
    'vm-04': { name: 'vm-04', vendor_account_resource_id: 'account_x', claude: { email: 'dave@gmail.com' } },
    // GPT 槽位同样按授权邮箱
    'vm-05': { name: 'vm-05', codex: { email: 'erin@openai.test' } },
  })
  const renamed = backfillSlotNames(dir)
  assert.deepEqual(
    renamed.map((row) => `${row.id}:${row.from}->${row.to}`),
    ['vm-01:vm-01->alice@gmail.com', 'vm-05:vm-05->erin@openai.test'],
  )
  assert.equal(readVm(dir, 'vm-01').name, 'alice@gmail.com')
  assert.equal(readVm(dir, 'vm-02').name, 'billing-prod')
  assert.equal(readVm(dir, 'vm-03').name, 'vm-03')
  assert.equal(readVm(dir, 'vm-04').name, 'vm-04')
  assert.equal(readVm(dir, 'vm-05').name, 'erin@openai.test')
})

test('backfill keeps names unique across the slots it renames in one pass', () => {
  const dir = root({
    'vm-01': { name: 'vm-01', claude: { email: 'abc@gmail.com' } },
    // 同一个邮箱的第二个槽位：保持编号名
    'vm-02': { name: 'vm-02', claude: { email: 'abc@gmail.com' } },
  })
  assert.equal(backfillSlotNames(dir).length, 1)
  assert.equal(readVm(dir, 'vm-01').name, 'abc@gmail.com')
  assert.equal(readVm(dir, 'vm-02').name, 'vm-02')
})

test('backfill is idempotent: a second pass renames nothing', () => {
  const dir = root({ 'vm-01': { name: 'vm-01', claude: { email: 'alice@gmail.com' } } })
  assert.equal(backfillSlotNames(dir).length, 1)
  assert.equal(backfillSlotNames(dir).length, 0)
  assert.equal(readVm(dir, 'vm-01').name, 'alice@gmail.com')
})
