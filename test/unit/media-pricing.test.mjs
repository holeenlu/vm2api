import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { groupMediaPolicy, imageBillingTier, mediaCharge } from '../../src/lib/admin/media-pricing.mjs'
import { calculateCost, costColumnsFromUsage } from '../../src/lib/admin/pricing.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'

test('image tiers follow the longest edge, unknown sizes bill as 2K', () => {
  assert.equal(imageBillingTier('1024x1024'), '1K')
  assert.equal(imageBillingTier('1536x1024'), '2K')
  assert.equal(imageBillingTier('3840x2160'), '4K')
  assert.equal(imageBillingTier('4k'), '4K')
  assert.equal(imageBillingTier('auto'), '2K')
  assert.equal(imageBillingTier(undefined), '2K')
})

test('web search bills per call at the group price, default $0.01, 0 is free', () => {
  const usage = { web_search_calls: 1 }
  assert.equal(mediaCharge(usage, groupMediaPolicy({})).total_cost, 0.01)
  assert.equal(mediaCharge(usage, groupMediaPolicy({ web_search_price_per_call: 0.02 })).total_cost, 0.02)
  assert.equal(mediaCharge(usage, groupMediaPolicy({ web_search_price_per_call: 0 })).total_cost, 0)
  const cost = calculateCost(usage, 'gpt-5.5', { media: groupMediaPolicy({}) })
  assert.equal(cost.known, true)
  assert.equal(cost.total_cost, 0.01)
  assert.equal(cost.rate_multiplier, null)
  assert.equal(costColumnsFromUsage(usage, 'gpt-5.5', null, { media: groupMediaPolicy({}) }).web_search_cost, 0.01)
})

test('image count billing uses tier prices and the independent image rate only when enabled', () => {
  const usage = { image_endpoint: true, image_count: 2, image_size: '1024x1024' }
  assert.equal(mediaCharge(usage, groupMediaPolicy({})), null, 'off by default: token pricing applies')
  const defaults = mediaCharge(usage, groupMediaPolicy({ image_count_billing: true }))
  assert.equal(defaults.total_cost, 0.268)
  assert.equal(defaults.rate_multiplier, null)
  const custom = mediaCharge(
    { ...usage, image_size: '3840x2160' },
    groupMediaPolicy({
      image_count_billing: true,
      image_price_4k: 0.3,
      image_rate_independent: true,
      image_rate_multiplier: 0.5,
    }),
  )
  assert.equal(custom.total_cost, 0.6)
  assert.equal(custom.rate_multiplier, 0.5)
  // Responses 内的生图工具不是 Images 端点，继续按 token 计价
  assert.equal(mediaCharge({ image_count: 2 }, groupMediaPolicy({ image_count_billing: true })), null)
})

test('groups persist media billing fields with validation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-groups-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new GroupsRepo(db)
    const group = await repo.create({ name: 'Media', platform: 'openai' })
    assert.equal(group.allow_image_generation, true)
    assert.equal(group.web_search_price_per_call, null)
    const updated = await repo.update(group.id, {
      allow_image_generation: false,
      image_count_billing: true,
      image_rate_independent: true,
      image_rate_multiplier: 0.8,
      image_price_1k: 0.1,
      image_price_2k: '',
      web_search_price_per_call: 0,
    })
    assert.equal(updated.allow_image_generation, false)
    assert.equal(updated.image_count_billing, true)
    assert.equal(updated.image_rate_multiplier, 0.8)
    assert.equal(updated.image_price_1k, 0.1)
    assert.equal(updated.image_price_2k, null)
    assert.equal(updated.web_search_price_per_call, 0)
    await assert.rejects(() => repo.update(group.id, { web_search_price_per_call: -1 }), /单价/)
    await assert.rejects(() => repo.update(group.id, { image_count_billing: 'yes' }), /布尔/)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
